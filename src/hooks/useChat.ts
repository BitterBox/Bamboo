// ============================================================
// useChat — 聊天核心逻辑 Hook
// 封装发送消息、重试、停止流式接收的完整流程
//
// 职责：
//   1. 调用 llmService.streamChat 并将 chunk 写入 chatStore
//   2. 通过 AbortController 支持用户中途停止
//   3. 错误处理：区分用户主动取消和真实错误，给出友好提示
//   4. MCP Agentic Loop：若 LLM 返回 tool_calls，执行工具后继续请求
//
// 多会话支持：
//   - 所有操作都基于 currentSessionId
//   - 流式响应的 chunk 严格写入对应会话
//   - 切换会话不影响后台流式响应
// ============================================================

import { useChatStore, flushSessionUpdates } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { llmService } from '../services/llm';
import { resolveConfig, toOpenAIMessages, reconcileContextMessages } from '../services/llmUtils';
import { mcpRegistry } from '../services/mcp';
import { getPermissionAwareToolDefinitions, getEffectiveMCPConfig } from '../services/mcp/permissionAware';
import { getActivePath, getPathToRoot } from '../utils/treeUtils';
import { autoNameSession } from '../services/autoNameService';
import type { Message, ToolCall, ToolResult } from '../types';
import type OpenAI from 'openai';

/** 从文件路径找到所属的允许目录（轻量版，与 lockManager.js 的 findTargetDir 一致，最长匹配） */
function findTargetDir(filePath: string, allowedDirs: string[]): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  let bestMatch: string | null = null;
  let bestLen = 0;
  for (const dir of allowedDirs) {
    const dirNorm = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === dirNorm || normalized.startsWith(dirNorm + '/')) {
      if (dirNorm.length > bestLen) {
        bestMatch = dirNorm;
        bestLen = dirNorm.length;
      }
    }
  }
  return bestMatch;
}

/** 从 tool_calls 中提取写类型工具的目标文件路径 */
function extractWriteTargets(toolCalls: ToolCall[], allowedDirs: string[]): { filePath: string; dir: string }[] {
  const WRITE_TOOL_NAMES = new Set(['modify_code', 'write_file']);
  const targets: { filePath: string; dir: string }[] = [];
  for (const tc of toolCalls) {
    if (WRITE_TOOL_NAMES.has(tc.name)) {
      try {
        const args = JSON.parse(tc.arguments);
        if (args.path) {
          const dir = findTargetDir(args.path, allowedDirs);
          if (dir) targets.push({ filePath: args.path, dir });
        }
      } catch { /* arguments JSON 可能不完整 */ }
    }
  }
  return targets;
}

/** 
 * 标记会话中涉及指定文件的读操作结果为"[文件被修改]"
 * 
 * ⚠️ 使用 setState 直接更新 store，不调用 saveChatHistory，避免覆盖持久化数据。
 * 同时更新 content（UI 显示）和 toolResult.result（LLM 上下文），确保两端都看到占位符。
 */
function markStaleReads(sessionId: string, changedFiles: string[]) {
  const session = useChatStore.getState().sessions[sessionId];
  if (!session) return;

  const changedFileSet = new Set(changedFiles.map(f => f.replace(/\\/g, '/')));
  const readToolNames = new Set(['read_file', 'analyze_code', 'search', 'suggest_refactorings']);
  const staleIds: string[] = [];

  for (const msg of Object.values(session.messageTree)) {
    if (msg.role !== 'tool' || !msg.toolResult) continue;
    if (!readToolNames.has(msg.toolResult.name)) continue;

    const content = msg.toolResult.result;
    for (const filePath of changedFiles) {
      const normalized = filePath.replace(/\\/g, '/');
      if (content.includes(normalized)) {
        staleIds.push(msg.id);
        break;
      }
    }
  }

  if (staleIds.length === 0) return;

  // 直接 setState，不触发 saveChatHistory
  useChatStore.setState((prev) => {
    const s = prev.sessions[sessionId];
    if (!s) return prev;
    const updatedTree = { ...s.messageTree };
    for (const msgId of staleIds) {
      if (updatedTree[msgId]) {
        const m = updatedTree[msgId];
        updatedTree[msgId] = {
          ...m,
          content: '[文件被修改]',
          toolResult: m.toolResult ? { ...m.toolResult, result: '[文件被修改]' } : m.toolResult,
        };
      }
    }
    return {
      sessions: {
        ...prev.sessions,
        [sessionId]: { ...s, messageTree: updatedTree },
      },
    };
  });
}

/**
 * 处理目录写锁冲突：删除不完整的 assistant 消息、排队等待、修复脏读、重建上下文
 *
 * @param lockResult 已从 mcpAcquireDirLocks 获取的锁状态
 * @returns 返回 retry 并携带新的 loopController 和 currentMessages，调用方应重试本轮 LLM 请求
 */
async function handleLockConflict(
  sessionId: string,
  lockResult: { status: 'acquired' | 'blocked'; blocked: Array<{ filePath: string; dir: string; holder: string }> },
  allowedDirs: string[],
  currentMessages: OpenAI.ChatCompletionMessageParam[],
  signal: AbortSignal,
): Promise<{ action: 'retry'; currentMessages: OpenAI.ChatCompletionMessageParam[]; loopController: AbortController } | { action: 'aborted' }> {
  const store = useChatStore.getState();

  if (lockResult.status === 'acquired') {
    // 意外情况：锁已被释放，重试本轮（保留原有上下文）
    return { action: 'retry', currentMessages, loopController: new AbortController() };
  }

  // 1. 删除本轮创建的 assistant 消息（内容为空 + 不完整 tool_calls）
  //    🐛 Bug 修复：从活跃路径末尾向前查找当前轮的 assistant 消息，
  //       而非遍历整棵树找第一个匹配的。原代码在多轮 MCP 循环中，
  //       会误删祖先 assistant（插得更早、排在 Object.values 前面），
  //       导致 removeSubtree 连带清除整棵子树，所有消息被删到只剩第一条。
  //
  //    ⚠️ 当前的 deleteMessage 对单子节点做"上提"而非递归删除，
  //        导致 tool 消息链被 reparent 到父节点变成孤儿。
  //        这里需要显式清理被上提的工具消息。
  const session = useChatStore.getState().sessions[sessionId];
  if (session) {
    const activePath = getPathToRoot(session.messageTree, session.execLeafId);
    const currentAssistant = [...activePath].reverse().find(
      m => m.role === 'assistant' && m.content === '' && m.toolCalls && m.toolCalls.length > 0
    );
    if (currentAssistant) {
      // 先收集工具调用的 ID，deleteMessage 后会丢失引用
      const toolCallIds = currentAssistant.toolCalls!.map(tc => tc.id);
      store.deleteMessage(sessionId, currentAssistant.id);
      // 显式清理被上提的孤儿 tool 消息：在剩余树中查找 toolCallId 匹配的 tool 消息
      const stateAfterDelete = useChatStore.getState().sessions[sessionId];
      if (stateAfterDelete) {
        for (const toolMsg of Object.values(stateAfterDelete.messageTree)) {
          if (toolMsg.role === 'tool' && toolMsg.toolResult && toolCallIds.includes(toolMsg.toolResult.toolCallId)) {
            store.deleteMessage(sessionId, toolMsg.id);
          }
        }
      }
    }
  }

  // 2. 标记排队状态
  //    同时关闭 isAgentRunning，确保 UI 指示灯从黄色（工具执行）切换到红色（排队等待）
  store.setAgentRunning(sessionId, false);
  const blockedFiles = lockResult.blocked.map((b) => b.filePath);
  const blockedDirs = [...new Set(lockResult.blocked.map((b) => b.dir) as string[])];
  const blockedHolderIds = [...new Set(lockResult.blocked.map((b) => b.holder))];
  store.setQueued(sessionId, true, blockedFiles, blockedDirs, blockedHolderIds);

  // 3. 等待锁释放（IPC 长等待，阻塞直到锁可用）
  //    使用 Promise.race 配合 AbortSignal，确保用户点击"停止"时能中断排队
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('用户中止排队', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    await Promise.race([
      window.electronAPI!.mcpWaitForDirLocks(sessionId, lockResult.blocked),
      abortPromise,
    ]);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // 用户点击了停止，清理排队状态并退出
      if (window.electronAPI) {
        window.electronAPI.mcpCancelWaitForLocks(sessionId);
      }
      store.setQueued(sessionId, false, [], []);
      flushSessionUpdates(sessionId);
      return { action: 'aborted' };
    }
    throw err;
  }

  // 4. 修复旧读取
  markStaleReads(sessionId, blockedFiles);

  // 5. 添加一条 user 提示消息
  const fileList = blockedFiles.map((f: string) => `- \`${f}\``).join('\n');
  store.addMessage(sessionId, {
    role: 'user',
    content: `⚠️ 以下文件在排队期间已被其他会话修改，请重新读取后继续操作：\n${fileList}`,
  });

  // 6. 取消排队状态
  store.setQueued(sessionId, false, [], []);

  // 7. 清理残留在缓冲区中的 toolCalls，防止被下一轮 flushSessionUpdates 写回
  flushSessionUpdates(sessionId);

  // 8. 重建上下文
  const newSession = useChatStore.getState().sessions[sessionId];
  const reconciled = reconcileContextMessages(
    getPathToRoot(newSession.messageTree, newSession.execLeafId)
  );
  const newMessages = toOpenAIMessages(reconciled);

  return { action: 'retry', currentMessages: newMessages, loopController: new AbortController() };
}

/**
 * 将一致性修复结果同步到 store 的 messageTree 中，让 UI 能显示修复后的
 * _reconcile_tool_call_id 工具调用和缺失的 tool 结果占位消息。
 *
 * 使用 setState 直接操作 messageTree，不经过 addMessage/addChildMessage，
 * 避免修改 execLeafId 影响后续 doStream 流程。
 */
function syncReconciliationToStore(
  sessionId: string,
  originalPath: Message[],
  reconciledPath: Message[]
): void {
  const toolCallsUpdates: Record<string, ToolCall[]> = {};
  const newMessages: Message[] = [];

  const maxLen = Math.max(originalPath.length, reconciledPath.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = i < originalPath.length ? originalPath[i] : null;
    const recon = i < reconciledPath.length ? reconciledPath[i] : null;

    if (!orig && recon) {
      // 新插入的消息（如缺失 tool 结果的占位）
      newMessages.push(recon);
    } else if (orig && recon && orig.toolCalls !== recon.toolCalls) {
      toolCallsUpdates[recon.id] = recon.toolCalls!;
    }
  }

  if (Object.keys(toolCallsUpdates).length === 0 && newMessages.length === 0) return;

  useChatStore.setState((state) => {
    const s = state.sessions[sessionId];
    if (!s) return state;

    let tree = { ...s.messageTree };

    for (const [id, toolCalls] of Object.entries(toolCallsUpdates)) {
      if (tree[id]) {
        tree[id] = { ...tree[id], toolCalls };
      }
    }

    for (const msg of newMessages) {
      tree[msg.id] = msg;
    }

    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...s,
          messageTree: tree,
          updatedAt: Date.now(),
        },
      },
    };
  });
}

/** 从 tool_call 中提取读工具的目标路径（写工具返回 null，不走读等待） */
function extractReadToolPath(tc: ToolCall): string | null {
  if (tc.name === 'modify_code' || tc.name === 'write_file') return null;
  try {
    const args = JSON.parse(tc.arguments);
    return args.path || null;
  } catch {
    return null;
  }
}

export const useChat = () => {
  const store = useChatStore();

  /**
   * 终止当前会话的流式请求（用户点击"停止"按钮时调用）
   */
  const stopStreaming = () => {
    const { currentSessionId, sessions } = useChatStore.getState();
    if (!currentSessionId) return;

    const session = sessions[currentSessionId];
    if (session?.abortController) {
      session.abortController.abort();
    }

    // 如果当前正在排队等待锁释放，从等待队列中移除，确保排队被终止
    if (session?.isQueued && window.electronAPI) {
      window.electronAPI.mcpCancelWaitForLocks(currentSessionId);
    }

    // 🔧 释放该会话持有的所有目录写锁，防止停止后锁残留导致其他会话无法写入
    if (window.electronAPI) {
      window.electronAPI.mcpReleaseDirLocks(currentSessionId).catch((err) =>
        console.warn('[stopStreaming] 释放目录锁失败:', err)
      );
    }
  };

  /**
   * 公共流式请求逻辑（支持 MCP Agentic Loop）
   *
   * 若 MCP 已启用且 LLM 返回 tool_calls，自动执行工具并继续请求，
   * 直到无工具调用或用户手动停止。
   *
   * @param sessionId 目标会话 ID
   * @param contextMessages 发送给 LLM 的上下文（不含空 assistant 占位）
   */
  const doStream = async (
    sessionId: string,
    contextMessages: OpenAI.ChatCompletionMessageParam[]
  ) => {
    // 直接从当前会话读取 LLM 和 MCP 配置（创建时已从智能体快照，不再回退）
    const session = useChatStore.getState().sessions[sessionId];
    const sessionLLMConfig = session?.llmConfig;
    const effectiveMCP = session?.mcpConfig ?? getEffectiveMCPConfig(sessionId);
    const allowedDirs = effectiveMCP.allowedDirs || [];
    const tools = (effectiveMCP.enabled && (effectiveMCP.fileToolEnabled || effectiveMCP.codeToolEnabled || effectiveMCP.pythonToolEnabled) && window.electronAPI)
      ? getPermissionAwareToolDefinitions(sessionId)
      : [];

    let currentMessages = [...contextMessages];
    let round = 0;

    // 🔧 整个 Agentic Loop 共用一个 AbortController，覆盖流式 + 工具执行两个阶段，
    // 确保用户在工具执行期间点击"停止"也能中断后续操作。
    // ⚠️ 使用 let 而非 const：锁冲突重试时需要新建 AbortController（旧 abort 无法复活）
    let loopController = new AbortController();
    store.setAbortController(sessionId, loopController);
    // 注意：setAgentRunning 不在此处调用，仅在检测到工具调用或进入工具执行阶段时设置

    try {
      // 使用 while(true) + 内部分支控制，确保至少执行一轮 LLM 调用。
      while (true) {
        // 用户在工具执行期间点了"停止"，跳出循环
        if (loopController.signal.aborted) break;

        round++;

        // 🐛 Bug 修复：在每一轮流式开始前，主动 flush 上一轮的 pending chunks，
        // 防止防抖定时器跨轮残留导致内容被错误追加到 tool 消息上。
        flushSessionUpdates(sessionId);

        // ── 目录写锁：预取当前锁状态（每轮一次 IPC，轻量） ──
        let lockedDirsSnapshot: Map<string, string> = new Map();
        if (window.electronAPI) {
          const state: { dir: string; holder: string }[] = await window.electronAPI!.mcpGetDirLockState();
          lockedDirsSnapshot = new Map(state.map(s => [s.dir, s.holder]));
        }

        store.setStreaming(sessionId, true);
        // 🔧 Bug 修复：新的一轮流式开始时重置 isAgentRunning，
        // 防止上一轮残留的 true 值导致本轮 LLM 正常输出文本时
        // 输入框 placeholder 错误显示"正在生成工具调用…"
        store.setAgentRunning(sessionId, false);

        // 解析本轮使用的实际模型名（直接从会话配置读取，不再回退到智能体/全局）
        const { apiProviders } = useSettingsStore.getState();
        const resolvedConfig = sessionLLMConfig ? resolveConfig(sessionLLMConfig, apiProviders) : { model: '' };
        const resolvedModel = resolvedConfig.model;
        const providerName = resolvedConfig.providerId
          ? apiProviders.find((p) => p.id === resolvedConfig.providerId)?.name
          : undefined;

        // Bug 修复：若 execLeafId 已指向空 assistant（forkFrom 创建的占位），复用而非新建
        const preAddSession = useChatStore.getState().sessions[sessionId];
        const existingPlaceholder = preAddSession?.execLeafId
          ? preAddSession.messageTree[preAddSession.execLeafId]
          : null;
        if (existingPlaceholder && existingPlaceholder.role === 'assistant' && existingPlaceholder.content === '' && !existingPlaceholder.toolCalls) {
          // forkFrom 已为该分支创建空 assistant 占位，直接补全 model / providerName 字段
          useChatStore.setState((prev) => {
            const s = prev.sessions[sessionId];
            if (!s) return prev;
            return {
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...s,
                  messageTree: {
                    ...s.messageTree,
                    [existingPlaceholder.id]: {
                      ...existingPlaceholder,
                      model: resolvedModel,
                      ...(providerName ? { providerName } : {}),
                    },
                  },
                },
              },
            };
          });
        } else {
          store.addMessage(sessionId, {
            role: 'assistant',
            content: '',
            model: resolvedModel,
            ...(providerName ? { providerName } : {}),
          });
        }

        let capturedToolCalls: ToolCall[] | null = null;
        let aborted = false;
        let streamCompleted = false;
        // ⏳ 流式过程中检测到的目录锁冲突（用 ref 对象绕过 TS 回调类型收窄限制）
        const lockConflictRef = { value: null as { filePath: string; dir: string; holder: string } | null };

        try {
          // 获取当前会话的思考模式设置
          const currentSession = useChatStore.getState().sessions[sessionId];
          const thinkingMode = currentSession?.thinkingMode ?? 'auto';
          
          for await (const chunk of llmService.streamChat(
            currentMessages,
            loopController.signal,
            sessionLLMConfig ?? { model: '' },
            effectiveMCP,
            (usage) => store.setLastMessageTokenUsage(sessionId, usage),
            (reasoningChunk) => store.updateLastMessageReasoning(sessionId, reasoningChunk),
            tools.length > 0 ? tools : undefined,
            () => {
              // 🔧 LLM 开始输出工具调用 delta 时立即进入 Agent 状态，让 UI 不再静止
              store.setAgentRunning(sessionId, true);
            },
            (toolCalls) => { capturedToolCalls = toolCalls; },
            // 🔧 流式过程中实时更新消息的 toolCalls，让 UI 可以实时展示参数累积
            //    同时做轻量正则检测：发现写工具命中已锁目录时立即中断流，节省词元开销
            (toolCalls) => {
              store.setLastMessageToolCalls(sessionId, toolCalls);

              // ⏳ 轻量正则检测（不 IPC、不完整 JSON 解析，纯内存正则）+ 层级感知
              if (!lockConflictRef.value && lockedDirsSnapshot.size > 0) {
                for (const tc of toolCalls) {
                  if (tc.name !== 'modify_code' && tc.name !== 'write_file') continue;
                  const m = tc.arguments.match(/"path"\s*:\s*"([^"]*)/);
                  if (!m) continue;
                  const partialPath = m[1];
                  const targetDir = findTargetDir(partialPath, allowedDirs);
                  if (!targetDir) continue;
                  // 层级检测：用 exact + '/' 前缀，避免 './A' 误匹配 './AB'
                  let conflictDir: string | null = null;
                  for (const [lockedDir, holder] of lockedDirsSnapshot) {
                    const l = lockedDir.replace(/\\/g, '/');
                    if (targetDir === l || targetDir.startsWith(l + '/') || l.startsWith(targetDir + '/')) {
                      conflictDir = lockedDir;
                      break;
                    }
                  }
                  if (conflictDir) {
                    lockConflictRef.value = {
                      filePath: partialPath,
                      dir: targetDir,
                      holder: lockedDirsSnapshot.get(conflictDir)!,
                    };
                    loopController.abort(); // 立即中断 API 流
                    return;
                  }
                }
              }
            },
            thinkingMode,
            () => store.setRateLimited(sessionId, true)
          )) {
            store.setRateLimited(sessionId, false);
            store.updateLastMessage(sessionId, chunk);
          }
          streamCompleted = true;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            if (lockConflictRef.value) {
              // 锁冲突主动 abort，不是用户点的停止
              aborted = false;
            } else {
              aborted = true;
            }
          } else {
            console.error('Stream error:', error);
            let errorMessage = '\n\n[错误: 无法连接到 LLM 服务]\n';
            if (error instanceof Error) {
              errorMessage += `详情: ${error.message}\n`;
            }
            errorMessage += '\n请检查：\n';
            errorMessage += '1. API 密钥是否正确\n';
            errorMessage += '2. API 端点是否可访问\n';
            errorMessage += '3. 模型名称是否正确\n';
            store.updateLastMessage(sessionId, errorMessage);
          }
        } finally {
          store.setStreaming(sessionId, false);
          store.setRateLimited(sessionId, false);
        }

        // ⏳ 锁冲突 → 通过共享函数处理：删除 assistant 消息、排队等待、修复脏读、重试
        if (lockConflictRef.value) {
          // 🔧 立即关闭 isAgentRunning，防止 await mcpAcquireDirLocks 异步 gap 期间
          //     UI 指示灯回落到黄色（工具执行），而非预期的红色（排队等待）
          store.setAgentRunning(sessionId, false);
          const conflict = lockConflictRef.value;
          // 共享函数内部会调用 mcpAcquireDirLocks，若意外 acquired 直接返回重试
          const lockResult = await window.electronAPI!.mcpAcquireDirLocks(
            sessionId, [conflict.filePath], allowedDirs
          );
          const result = await handleLockConflict(sessionId, lockResult, allowedDirs, currentMessages, loopController.signal);
          if (result.action === 'aborted') {
            aborted = true;
            break;
          }
          loopController = result.loopController;
          store.setAbortController(sessionId, loopController);
          currentMessages = result.currentMessages;
          continue;
        }

        // 用户中止 → 停止循环
        if (aborted) break;

        // 流式过程出错（非用户中止） → 停止循环
        if (!streamCompleted) break;

        // 无工具调用 → 正常结束
        if (!capturedToolCalls || (capturedToolCalls as ToolCall[]).length === 0) break;

        // ── 写工具锁检查（流结束后，执行工具前，完整检测） ──────────

        const writeTargets = extractWriteTargets(capturedToolCalls as ToolCall[], allowedDirs);
        if (writeTargets.length > 0 && window.electronAPI) {
          const lockResult = await window.electronAPI!.mcpAcquireDirLocks(
            sessionId,
            writeTargets.map(w => w.filePath),
            allowedDirs,
          );

          if (lockResult.status === 'blocked') {
            // 锁被占用 → 通过共享函数处理：删除 assistant 消息、排队等待、修复脏读、重试
            // 🔧 立即关闭 isAgentRunning，防止 handleLockConflict 中 await 异步 gap 期间
            //     UI 指示灯回落到黄色（工具执行）
            store.setAgentRunning(sessionId, false);
            const conflictResult = await handleLockConflict(sessionId, lockResult, allowedDirs, currentMessages, loopController.signal);
            if (conflictResult.action === 'aborted') {
              aborted = true;
              break;
            }
            loopController = conflictResult.loopController;
            store.setAbortController(sessionId, loopController);
            currentMessages = conflictResult.currentMessages;
            continue;
          }
          // 锁获取成功，继续执行工具
        }

        // ── 工具执行阶段 ──────────────────────────────────────

        // 🔧 确保工具执行阶段 isAgentRunning 为 true（防御性，onToolCallStart 回调通常已设置）
        store.setAgentRunning(sessionId, true);

        // 把 tool_calls 写入最后一条 assistant 消息
        store.setLastMessageToolCalls(sessionId, capturedToolCalls as ToolCall[]);

        // 获取当前 assistant 消息内容（可能为空，工具调用时 LLM 通常不输出正文）
        const currentSession = useChatStore.getState().sessions[sessionId];
        const lastAssistantMsg = getPathToRoot(currentSession.messageTree, currentSession.execLeafId)
          .slice().reverse()
          .find((m) => m.role === 'assistant');
        const lastAssistantContent = lastAssistantMsg?.content ?? '';

        // 构建 assistant message with tool_calls（用于下一轮上下文）
        const assistantMsgForContext = {
          role: 'assistant',
          content: lastAssistantContent,
          tool_calls: (capturedToolCalls as ToolCall[]).map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
          reasoning_content: lastAssistantMsg?.reasoning ?? '',
        } as OpenAI.ChatCompletionMessageParam;

        // 逐个执行工具，追加 tool 角色消息
        const toolResultMessages: OpenAI.ChatCompletionMessageParam[] = [];
        for (const tc of capturedToolCalls as ToolCall[]) {
          if (loopController.signal.aborted) break;

          store.setSessionCurrentTool(sessionId, { name: tc.name, arguments: tc.arguments });
          await new Promise((r) => setTimeout(r, 0));

          let toolResult: ToolResult;
          try {
            // 读工具：如果目标目录被其他 session 写锁，排队等待（不持锁，等释放后立刻读）
            // 🎯 防抖优化：延迟 200ms 再设置排队状态，避免单 session 下无锁冲突时
            //    "排队中"瞬时闪烁（await 导致 setQueued(true/false) 跨越 microtask 边界，
            //    无法被 React 批处理合并）。只有真正需要等待时才显示排队提示。
            if (window.electronAPI && allowedDirs.length > 0) {
              const readPath = extractReadToolPath(tc);
              if (readPath) {
                const targetDir = findTargetDir(readPath, allowedDirs);
                if (targetDir) {
                  const queuedTimer = setTimeout(() => {
                    // 🔧 排队指示灯应为红色而非黄色：关闭 isAgentRunning 防止
                    //     SessionList 回落匹配到 agentRunningIndicator（黄色）
                    store.setAgentRunning(sessionId, false);
                    store.setQueued(sessionId, true, [readPath], [targetDir]);
                  }, 200);
                  try {
                    const abortPromise = new Promise<never>((_, reject) => {
                      const onAbort = () => {
                        loopController.signal.removeEventListener('abort', onAbort);
                        reject(new DOMException('用户中止', 'AbortError'));
                      };
                      if (loopController.signal.aborted) {
                        onAbort();
                      } else {
                        loopController.signal.addEventListener('abort', onAbort, { once: true });
                      }
                    });
                    await Promise.race([
                      window.electronAPI!.mcpWaitDirLockRelease(targetDir, sessionId),
                      abortPromise,
                    ]);
                  } catch (err: unknown) {
                    clearTimeout(queuedTimer);
                    store.setQueued(sessionId, false, [], []);
                    // 排队被中断（用户停止），恢复 isAgentRunning 让 finally 统一清理
                    store.setAgentRunning(sessionId, true);
                    if (err instanceof DOMException && err.name === 'AbortError') {
                      break; // 用户点击停止，跳出工具执行循环
                    }
                    throw err;
                  }
                  clearTimeout(queuedTimer);
                  store.setQueued(sessionId, false, [], []);
                  // 排队结束，恢复 isAgentRunning 继续执行工具
                  store.setAgentRunning(sessionId, true);
                }
              }
            }

            const { result, isError } = await mcpRegistry.execute(tc.name, tc.arguments, null, sessionId);
            toolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result,
              isError,
            };
          } catch (err) {
            console.error(`[MCP] 工具 ${tc.name} 执行异常:`, err);
            toolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: `[工具执行异常] ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }

          store.addMessage(sessionId, {
            role: 'tool',
            content: toolResult.result,
            toolResult,
          });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResult.result,
          });
        }

        store.setSessionCurrentTool(sessionId, null);

        if (loopController.signal.aborted) break;

        currentMessages = [
          ...currentMessages,
          assistantMsgForContext,
          ...toolResultMessages,
        ];
      }
    } finally {
      // 🔧 统一清理：无论正常结束、用户中断还是异常退出，都确保状态被正确重置
      // 🔧 先 flush 残留缓冲区，防止 pending chunks 在循环结束后丢失
      flushSessionUpdates(sessionId);
      store.setAbortController(sessionId, null);
      store.setStreaming(sessionId, false);
      store.setAgentRunning(sessionId, false);
      store.setSessionCurrentTool(sessionId, null);
      store.setQueued(sessionId, false, [], []);
      // 🔧 释放该会话持有的所有目录写锁，防止手动停止后锁残留导致其他会话死等
      if (window.electronAPI) {
        window.electronAPI.mcpReleaseDirLocks(sessionId).catch((err) =>
          console.warn('[useChat] 释放目录锁失败:', err)
        );
      }
    }
  };

  /**
   * 发送用户消息并获取 AI 流式回复
   */
  const sendMessage = async (content: string) => {
    const { currentSessionId, sessions } = useChatStore.getState();
    if (!currentSessionId) return;

    // 防止用户在流式响应进行中或工具执行期间重复发送消息
    if (sessions[currentSessionId]?.isStreaming || sessions[currentSessionId]?.isAgentRunning) return;

    const sessionId = currentSessionId;

    // 如果是第一条用户消息，异步调用 LLM 自动生成有意义的标题
    // （从 chatStore.addMessage 中移出，避免数据层反向依赖服务层）
    // ⚠️ 必须在 addMessage 之前检查：addMessage 会将标题从"新对话"改为内容截取，
    //    之后再检查 title.startsWith('新对话') 将永远为 false
    const shouldAutoName = (() => {
      const sessionBefore = useChatStore.getState().sessions[sessionId];
      if (!sessionBefore) return false;
      const hasNoUserMsg = !Object.values(sessionBefore.messageTree).some(
        (m) => m.role === 'user',
      );
      return hasNoUserMsg && sessionBefore.title.startsWith('新对话');
    })();

    store.addMessage(sessionId, { role: 'user', content });

    if (shouldAutoName) {
      autoNameSession(sessionId);
    }

    const session = useChatStore.getState().sessions[sessionId];
    if (!session) return;

    // 🔧 构建上下文前先执行工具调用一致性修复
    const activePath = getActivePath(session);
    const reconciledMessages = reconcileContextMessages(activePath);

    // 将修复结果同步到 store，让 UI 能显示 _reconcile_tool_call_id 等修复标记
    syncReconciliationToStore(sessionId, activePath, reconciledMessages);

    const contextMessages = toOpenAIMessages(reconciledMessages);

    await doStream(sessionId, contextMessages);
  };

  /**
   * 使用指定会话（默认当前会话）的现有消息列表重新请求 LLM（不添加用户消息）
   */
  const streamNewResponse = async (targetSessionId?: string) => {
    const sessionId = targetSessionId ?? useChatStore.getState().currentSessionId;
    if (!sessionId) return;

    const session = useChatStore.getState().sessions[sessionId];
    if (!session || session.isStreaming || session.isAgentRunning) return;  

    // 🔧 构建上下文前先执行工具调用一致性修复
    const activePath = getActivePath(session);
    const reconciledMessages = reconcileContextMessages(activePath);

    // 将修复结果同步到 store，让 UI 能显示 _reconcile_tool_call_id 等修复标记
    syncReconciliationToStore(sessionId, activePath, reconciledMessages);

    const contextMessages = toOpenAIMessages(reconciledMessages);

    await doStream(sessionId, contextMessages);
  };

  /**
   * 重试指定消息
   */
  const retryFromMessage = async (id: string, role: Message['role'], content: string) => {
    const { currentSessionId, sessions } = useChatStore.getState();
    if (!currentSessionId) return;

    const session = sessions[currentSessionId];
    if (!session) return;

    if (session.isStreaming || session.isAgentRunning) return;

    const sessionId = currentSessionId;
    const sourceMsg = session.messageTree[id];
    if (!sourceMsg) return;

    if (role === 'user' || role === 'system') {
      // 重新获取最新 session
      const updatedSession = useChatStore.getState().sessions[sessionId];
      const tree = updatedSession?.messageTree ?? session.messageTree;

      const pathBeforeReconcile = getPathToRoot(tree, id);
      const reconciled = reconcileContextMessages(pathBeforeReconcile);
      syncReconciliationToStore(sessionId, pathBeforeReconcile, reconciled);
      const contextMessages = toOpenAIMessages(reconciled);
      store.addChildMessage(sessionId, id, 'assistant');
      await doStream(sessionId, contextMessages);
    } else {
      const parentId = sourceMsg.parentId;
      // 重新获取最新 session
      const updatedSession = useChatStore.getState().sessions[sessionId];
      const tree = updatedSession?.messageTree ?? session.messageTree;

      const pathBeforeReconcile = parentId ? getPathToRoot(tree, parentId) : [];
      const reconciled = reconcileContextMessages(pathBeforeReconcile);
      syncReconciliationToStore(sessionId, pathBeforeReconcile, reconciled);
      const contextMessages = toOpenAIMessages(reconciled);
      // 在源消息父节点下新建 assistant 子节点（等效于在原位置重建）
      if (parentId) {
        store.addChildMessage(sessionId, parentId, 'assistant');
      }
      await doStream(sessionId, contextMessages);
    }
  };

  return { sendMessage, retryFromMessage, stopStreaming, streamNewResponse };
};
