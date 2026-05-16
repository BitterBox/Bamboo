// ============================================================
// 聊天消息状态管理（Zustand store）
// 负责多会话管理、消息列表的 CRUD、流式更新标志、以及双环境持久化
//
// 持久化策略：
//   Electron → IPC → userData/chat-history.json
//   浏览器  → localStorage key: 'chat-history'
//
// 多会话架构：
//   - sessions: Record<sessionId, Session> 存储所有会话
//   - sessionOrder: string[] 会话 ID 列表（按 updatedAt 降序）
//   - currentSessionId: string | null 当前激活的会话 ID
//   - 每个会话有独立的消息历史和流式状态
// ============================================================

import { create } from 'zustand';
import type { Message, Session, TokenUsage, ToolCall, ToolResult } from '../types';
import { DEFAULT_AGENT_ID } from '../types';
import { getActivePath, getPathToRoot, getChildLeaves, removeSubtree, ensureSystemRootNode } from '../utils/treeUtils';
import { generateTitle, createEmptySession } from '../utils/sessionHelpers';
import { loadChatHistoryImpl, saveChatHistoryImpl, resetSavingState, markSessionDirty, scheduleSave, registerSaveGetter } from './persistence';
import { useSettingsStore } from './settingsStore';
import { clearScrollCache, clearAllScrollCache } from '../utils/scrollCache';

// ── 防抖保存 ────────────────────────────────────────────────

/** draft 防抖持久化定时器（用户停止打字 1 秒后写盘） */
let draftTimer: NodeJS.Timeout | null = null;

// ── 流式渲染节流缓冲区 ────────────────────────────────────
// 每个会话一个 StreamBuffer，由 scheduleFlush（rAF 驱动）统一消费。
// 双阈值策略：① 时间阈值 20ms（~50fps）② 尺寸阈值 500 字（安全阀）
//
// content / reasoning 是增量追加，toolCalls 是全量替换（保留最新值）。
// toolCalls 绑定 messageId，消费时校验防止跨轮 rAF 写入错误的 assistant。

interface StreamBuffer {
  content: string;
  reasoning: string;
  toolCalls: { toolCalls: ToolCall[] | null; messageId: string } | null;
  lastRenderTime: number;
  flushScheduled: boolean;
}

const streamBuffers = new Map<string, StreamBuffer>();

function getBuffer(sessionId: string): StreamBuffer {
  let buf = streamBuffers.get(sessionId);
  if (!buf) {
    buf = { content: '', reasoning: '', toolCalls: null, lastRenderTime: 0, flushScheduled: false };
    streamBuffers.set(sessionId, buf);
  }
  return buf;
}

/** 最小渲染间隔（ms），作为主控条件 */
const LAST_MESSAGE_MIN_INTERVAL = 20;
/** 最大缓冲区字符数，超过此值强制渲染（安全阀） */
const LAST_MESSAGE_MAX_BUFFER = 500;

// ── Store 接口 ──────────────────────────────────────────────

interface ChatStore {
  /** 所有会话 */
  sessions: Record<string, Session>;
  /** 会话 ID 列表（按 updatedAt 降序） */
  sessionOrder: string[];
  /** 当前激活的会话 ID */
  currentSessionId: string | null;
  /** 是否已完成初始加载 */
  isLoaded: boolean;

  // ── 会话操作 ──────────────────────────────────────────────
  /** 创建新会话，返回 sessionId；agentId 省略时归入默认智能体 */
  createSession: (agentId?: string) => string;
  /** 切换会话 */
  switchSession: (sessionId: string) => void;
  /** 删除会话 */
  deleteSession: (sessionId: string) => void;
  /** 复制会话（深拷贝消息树、配置等，生成新会话） */
  duplicateSession: (sessionId: string) => string | null;
  /** 重命名会话 */
  renameSession: (sessionId: string, title: string) => void;
  /** 更新会话的输入框草稿文本（页面切换后恢复输入内容用，不触发持久化） */
  updateSessionDraft: (sessionId: string, draft: string) => void;

  // ── 消息操作 ──────────────────────────────────────────────
  addMessage: (sessionId: string, message: Omit<Message, 'id' | 'timestamp' | 'parentId'>) => string;
  updateLastMessage: (sessionId: string, content: string) => void;
  /** 将思考链 chunk 追加到最后一条消息的 reasoning 字段（流式接收推理内容时调用） */
  updateLastMessageReasoning: (sessionId: string, chunk: string) => void;
  clearMessages: (sessionId: string) => void;
  deleteMessage: (sessionId: string, id: string) => void;
  /** 批量删除消息：自动过滤后代节点（只保留最顶层的选中节点），正确处理根/分支/叶子 */
  deleteMessages: (sessionId: string, ids: string[]) => void;
  editMessage: (sessionId: string, id: string, content: string, toolResult?: ToolResult) => void;
  updateMessageRole: (sessionId: string, id: string, role: Message['role']) => void;
  truncateMessagesAfter: (sessionId: string, id: string) => void;
  /** 删除指定消息本身及其后所有消息（不保留目标消息） */
  truncateMessagesFrom: (sessionId: string, id: string) => void;
  /** 分支重试：在源消息的同级创建一条新消息（保留原消息），切换到新分支 */
  forkFrom: (sessionId: string, sourceMsgId: string, role: Message['role']) => void;
  /** 在指定消息下创建子消息（以 sourceMsgId 为父节点），切换到新分支。可传 content 直接填充内容 */
  addChildMessage: (sessionId: string, sourceMsgId: string, role: Message['role'], content?: string) => void;
  /** 切换到指定叶子消息所在的分支 */
  switchBranch: (sessionId: string, leafId: string) => void;

  // ── 智能体绑定 ──────────────────────────────────────────
  /** 将会话移动到指定智能体组 */
  setSessionRole: (sessionId: string, agentId: string) => void;
  /**
   * 拖拽排序：将 sessionId 移动到 targetAgentId 组中 afterSessionId 之后
   * afterSessionId = null 表示插到目标组最前
   */
  moveSession: (sessionId: string, targetAgentId: string, afterSessionId: string | null) => void;
  /**
   * 重排指定智能体组内的会话顺序（Framer Motion Reorder 回调使用）
   * @param agentId 智能体 ID
   * @param starred 新的关注会话 ID 顺序
   * @param unstarred 新的未关注会话 ID 顺序
   */
  reorderSessions: (agentId: string, starred: string[], unstarred: string[]) => void;
  /**
   * 将智能体的最新系统提示词同步到所有使用该智能体的会话的 system 根节点。
   * 编辑智能体提示词后调用。
   */
  syncSystemPrompts: (agentId: string) => void;

  // ── 星标关注 ──────────────────────────────────────────────
  /** 切换会话的关注（星标）状态，关注后会话自动置顶于智能体组内 */
  toggleStarSession: (sessionId: string) => void;
  /** 设置会话的思考模式（auto / enabled / disabled） */
  updateSessionThinkingMode: (sessionId: string, mode: 'auto' | 'enabled' | 'disabled') => void;
  /** 更新会话的 LLM 配置（含持久化） */
  updateSessionLLMConfig: (sessionId: string, config: import('../types').LLMConfig) => void;
  /** 更新会话的 MCP 配置（含持久化） */
  updateSessionMCPConfig: (sessionId: string, config: import('../types').MCPConfig) => void;

  // ── 流式状态管理 ──────────────────────────────────────────
  setStreaming: (sessionId: string, isStreaming: boolean) => void;
  setAgentRunning: (sessionId: string, isAgentRunning: boolean) => void;
  setRateLimited: (sessionId: string, isRateLimited: boolean) => void;
  setAbortController: (sessionId: string, controller: AbortController | null) => void;
  /** 🆕 登记一个新流（多流并行架构） */
  registerStream: (sessionId: string, stream: import('../types').StreamState) => void;
  /** 🆕 注销一个流 */
  unregisterStream: (sessionId: string, execLeafId: string) => void;
  /** 将 API 返回的精确 token 用量写入最后一条消息（assistant 消息流完成后调用） */
  setLastMessageTokenUsage: (sessionId: string, usage: TokenUsage) => void;
  /** 将工具调用列表写入最后一条 assistant 消息（流结束且有 tool_calls 时调用） */
  setLastMessageToolCalls: (sessionId: string, toolCalls: ToolCall[]) => void;

  /** 设置当前正在执行的工具信息（MCP Agentic Loop），用于 UI 实时显示工具调用参数 */
  setSessionCurrentTool: (sessionId: string, tool: { name: string; arguments: string } | null) => void;

  /** 设置排队状态（等待其他会话释放目录写锁） */
  setQueued: (sessionId: string, isQueued: boolean, queuedFiles: string[], queuedDirs: string[], queuedHolderIds?: string[]) => void;

  // ── 持久化 ────────────────────────────────────────────────
  loadChatHistory: () => Promise<void>;
  saveChatHistory: () => Promise<void>;

  // ── 清理 ──────────────────────────────────────────────────
  /** 清理所有资源（应用关闭时调用） */
  cleanup: () => void;
}

// ── Store 实例（HMR 安全：检测到旧实例则彻底销毁后重建，避免"幽灵 store"）───

const CHAT_STORE_KEY = '__ZUSTAND_CHAT_STORE__';

// 若旧 store 存在（partial HMR 重新执行本模块），彻底销毁再重建
const _oldStore = (window as any)[CHAT_STORE_KEY];
if (_oldStore) {
  _oldStore.getState().cleanup();
  delete (window as any)[CHAT_STORE_KEY];
  window.dispatchEvent(new CustomEvent('store-recreated'));
}

/** 模块级引用，供外部 flushSessionUpdates 调用统一的 flushBuffer */
let _flushBuffer: ((sessionId: string, mode: 'sync' | 'async') => boolean) | null = null;

/**
 * 异步清理指定会话的导入文件（不阻塞 UI）。
 * 从 deleteSession 中提取，避免 store action 内含动态 import 副作用。
 */
async function cleanupSessionFiles(sessionId: string): Promise<void> {
  try {
    const { listFiles, deleteFile } = await import('../services/fileManager');
    const files = await listFiles();
    const sessionFiles = files.filter((f) => f.sessionId === sessionId);
    for (const f of sessionFiles) {
      await deleteFile(f.filePath);
    }
  } catch (err) {
    console.warn('[chatStore] 清理会话导入文件失败:', err);
  }
}

export const useChatStore = (window as any)[CHAT_STORE_KEY] = create<ChatStore>()((set, get) => {
  // ── 渲染节流辅助（方案 A）───────────────────────────
  // 放置在 create 回调内以便访问 Zustand 的 get/set

  /**
   * 使用 rAF 调度渲染：满足时间阈值或尺寸阈值时立即 flush，
   * 否则等待下一帧再检查。
   *
   * 同时处理 content 和 reasoning 两个缓冲区，一次 set 完成两个的更新。
   */
  /**
   * 向事件循环让出控制权：使用 MessageChannel 调度一个 macrotask，
   * 延迟显著低于 setTimeout(fn, 0)（~1ms vs ~4ms），确保待处理的
   * 用户交互事件（点击、键盘）在 React 同步渲染之前被处理。
   */
  function yieldToEventLoop(fn: () => void): void {
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel();
      channel.port1.onmessage = fn;
      channel.port2.postMessage(null);
    } else {
      // 兜底：MessageChannel 不可用时回退到 setTimeout
      setTimeout(fn, 0);
    }
  }

  /**
   * 从会话的活跃路径中查找最后一条 assistant 消息。
   * 当 execLeafId 指向 tool 消息时（MCP 工具执行阶段），沿路径向上回溯。
   */
  function findLastAssistant(session: Session): Message | null {
    const activePath = getPathToRoot(session.messageTree, session.execLeafId);
    for (let i = activePath.length - 1; i >= 0; i--) {
      if (activePath[i].role === 'assistant') {
        return activePath[i];
      }
    }
    return null;
  }

  /**
   * 统一的缓冲区 flush 逻辑。sync 模式直接写入，async 模式通过
   * yieldToEventLoop 延迟写入（防吞字 + 防 isStreaming 覆盖）。
   *
   * 两种模式共享相同的：找 assistant → 校验 toolCalls → 消费缓冲区 → 写入 store。
   */
  function flushBuffer(sessionId: string, mode: 'sync' | 'async'): boolean {
    const buf = streamBuffers.get(sessionId);
    if (!buf) return false;

    // 取消 rAF 调度，防止 flush 后被 scheduleFlush 的后续回调覆盖
    buf.flushScheduled = false;

    const accumulated = buf.content;
    const accumulatedReasoning = buf.reasoning;
    const accumulatedToolCallsEntry = buf.toolCalls;
    const accumulatedToolCalls = accumulatedToolCallsEntry?.toolCalls ?? null;
    const storedMessageId = accumulatedToolCallsEntry?.messageId;

    if (!accumulated && !accumulatedReasoning && accumulatedToolCalls === null) return false;

    const session = get().sessions[sessionId];
    if (!session) return false;

    const lastAssistant = findLastAssistant(session);
    if (!lastAssistant) {
      // 孤儿缓冲区：清空并标记 flushPending=false
      buf.content = '';
      buf.reasoning = '';
      buf.toolCalls = null;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], flushPending: false },
        },
      }));
      return false;
    }

    const toolCallsMatch = !accumulatedToolCallsEntry || storedMessageId === lastAssistant.id;

    // 消费缓冲区
    if (accumulated) buf.content = '';
    if (accumulatedReasoning) buf.reasoning = '';
    if (accumulatedToolCallsEntry && toolCallsMatch) buf.toolCalls = null;

    /**
     * 将累积内容写入 store。assistant 参数在 sync 模式下是快照，
     * 在 async 模式下是 yieldToEventLoop 后重新读取的最新值。
     */
    const writeToStore = (assistant: Message) => {
      const updated: Message = { ...assistant };
      if (accumulated) updated.content = assistant.content + accumulated;
      if (accumulatedReasoning) updated.reasoning = (assistant.reasoning ?? '') + accumulatedReasoning;
      if (accumulatedToolCalls !== null && toolCallsMatch) updated.toolCalls = accumulatedToolCalls;

      const stillHasPending = (buf.content?.length ?? 0) > 0 || (buf.reasoning?.length ?? 0) > 0 || buf.toolCalls !== null;

      set((state) => {
        const freshIsStreaming = get().sessions[sessionId]?.isStreaming ?? false;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...state.sessions[sessionId],
              messageTree: {
                ...state.sessions[sessionId].messageTree,
                [updated.id]: updated,
              },
              // async 模式：用最新值覆盖 isStreaming，防止 rAF 快照中的旧值覆盖
              isStreaming: mode === 'async' ? freshIsStreaming : state.sessions[sessionId].isStreaming,
              flushPending: stillHasPending,
              // async + 流式中：跳过 updatedAt 更新，减少无关重渲染
              ...(mode === 'async' && freshIsStreaming ? {} : { updatedAt: Date.now() }),
            },
          },
        };
      });

      if (!get().sessions[sessionId]?.isStreaming) {
        markSessionDirty(sessionId);
      }
    };

    if (mode === 'sync') {
      writeToStore(lastAssistant);
    } else {
      // async：让出事件循环后再写入，重新读取 assistant 防吞字
      yieldToEventLoop(() => {
        const freshSession = get().sessions[sessionId];
        if (!freshSession) return;
        const freshAssistant = freshSession.messageTree[lastAssistant.id];
        if (!freshAssistant || freshAssistant.role !== 'assistant') return;
        writeToStore(freshAssistant);
      });
    }

    return true;
  }

  // 暴露给外部 flushSessionUpdates
  _flushBuffer = flushBuffer;

  function scheduleFlush(sessionId: string) {
    const buf = getBuffer(sessionId);
    if (buf.flushScheduled) return;
    buf.flushScheduled = true;

    requestAnimationFrame(() => {
      buf.flushScheduled = false;

      // 🆕 非当前会话：不 flush 也不重调度，避免高频 store set。
      // 累积内容等用户切回时由 switchSession 触发一次性 flush。
      if (get().currentSessionId !== sessionId) return;

      const accumulated = buf.content;
      const accumulatedReasoning = buf.reasoning;
      const accumulatedToolCalls = buf.toolCalls;

      if (!accumulated && !accumulatedReasoning && accumulatedToolCalls === null) return;

      const now = performance.now();
      const elapsed = now - buf.lastRenderTime;

      const contentExceeded = accumulated.length >= LAST_MESSAGE_MAX_BUFFER;
      const reasoningExceeded = accumulatedReasoning.length >= LAST_MESSAGE_MAX_BUFFER;
      const timeReady = elapsed >= LAST_MESSAGE_MIN_INTERVAL;

      // 🟢 toolCalls 不需要等待时间阈值：工具调用参数应尽可能实时展示
      if (timeReady || contentExceeded || reasoningExceeded || accumulatedToolCalls !== null) {
        buf.lastRenderTime = now;
        flushBuffer(sessionId, 'async');

        // 若仍在处理中则重调度（等待 activePath 变化后出现新的 assistant）
        const stillProcessing = get().sessions[sessionId]?.isStreaming || get().sessions[sessionId]?.isAgentRunning;
        if (stillProcessing) {
          scheduleFlush(sessionId);
        }
      } else {
        // 条件未满足，下帧继续检查
        scheduleFlush(sessionId);
      }
    });
  }

  /**
   * 创建带 system 根节点的会话。提取自 createSession 和 deleteSession 的重复逻辑。
   * @returns 已填充 messageTree / rootMessageId / execLeafId / viewLeafId 的 Session
   */
  function createSessionWithSystemNode(agentId: string): Session {
    const effectiveAgentId = agentId || DEFAULT_AGENT_ID;
    const { roles, llmConfig: globalLLM, mcpConfig: globalMCP } = useSettingsStore.getState();
    const agent = roles.find(r => r.id === effectiveAgentId);
    const sessionLLMConfig = { ...(agent?.llmConfig ?? globalLLM) };
    const sessionMCPConfig = { ...(agent?.mcpConfig ?? globalMCP) };
    const session = createEmptySession(effectiveAgentId, sessionLLMConfig, sessionMCPConfig);

    const sysMsgId = crypto.randomUUID();
    const sysMsg: Message = {
      id: sysMsgId,
      role: 'system',
      content: agent?.systemPrompt?.trim() || '',
      parentId: null,
      timestamp: Date.now(),
    };
    session.messageTree = { [sysMsgId]: sysMsg };
    session.rootMessageId = sysMsgId;
    session.execLeafId = sysMsgId;
    session.viewLeafId = sysMsgId;
    session.activeStreams = new Map();

    return session;
  }

  // 注册持久化模块的 store getter（调度器需要访问最新 state）
  registerSaveGetter(get);

  return {
  sessions: {},
  sessionOrder: [],
  currentSessionId: null,
  isLoaded: false,

  // ── 会话操作 ─────────────────────────────────────────────

  createSession: (agentId) => {
    const newSession = createSessionWithSystemNode(agentId);

    set((state) => ({
      sessions: { ...state.sessions, [newSession.id]: newSession },
      sessionOrder: [newSession.id, ...state.sessionOrder],
      currentSessionId: newSession.id,
    }));
    return newSession.id;
  },

  switchSession: (sessionId) => {
    // 校验会话是否存在，防止设置无效的 currentSessionId
    if (!get().sessions[sessionId]) return;
    set((state) => ({
      currentSessionId: sessionId,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          hasUnread: false,
        },
      },
    }));
    // 🆕 切回会话时一次性 flush 此前累积的 pending chunks
    scheduleFlush(sessionId);
  },

  deleteSession: (sessionId) => {
    const state = get();
    const { sessions, sessionOrder, currentSessionId } = state;

    // 清理：中止该会话的流式请求，防止内存泄漏
    const session = sessions[sessionId];
    if (session?.abortController) {
      session.abortController.abort();
    }

    // 清理：清除该会话的流式缓冲区和渲染节流状态
    streamBuffers.delete(sessionId);

    // 清理：清除该会话的滚动缓存（🐛 内存泄漏修复：此前 savedScrollTops 永不清理）
    clearScrollCache(sessionId);

    // 删除会话数据
    const newSessions = { ...sessions };
    delete newSessions[sessionId];
    const newOrder = sessionOrder.filter((id) => id !== sessionId);

    // 如果删除的是当前会话，需要切换
    let newCurrentId = currentSessionId;
    if (sessionId === currentSessionId) {
      if (newOrder.length > 0) {
        // 切换到最近更新的会话
        newCurrentId = newOrder[0];
      } else {
        // 无其他会话，创建新会话（含 system 根节点）
        const newSession = createSessionWithSystemNode(DEFAULT_AGENT_ID);
        newSessions[newSession.id] = newSession;
        newOrder.push(newSession.id);
        newCurrentId = newSession.id;
      }
    }

    set({
      sessions: newSessions,
      sessionOrder: newOrder,
      currentSessionId: newCurrentId,
    });
    markSessionDirty(sessionId);

    // 通知主进程清理该 session 持有的目录写锁和等待队列
    if (window.electronAPI) {
      window.electronAPI.mcpNotifySessionClosed(sessionId).catch((err) =>
        console.warn('[chatStore] 通知主进程清理锁失败:', err)
      );
    }

    // 异步清理该会话的导入文件（不阻塞 UI）
    cleanupSessionFiles(sessionId);
  },

  duplicateSession: (sessionId) => {
    const state = get();
    const original = state.sessions[sessionId];
    if (!original) return null;

    // 深拷贝消息树（每条消息生成新 ID，并维护 parentId 映射）
    const idMap = new Map<string, string>(); // oldId → newId
    const newMessageTree: Record<string, Message> = {};
    for (const msg of Object.values(original.messageTree)) {
      const newMsgId = crypto.randomUUID();
      idMap.set(msg.id, newMsgId);
      newMessageTree[newMsgId] = {
        ...msg,
        id: newMsgId,
        parentId: null, // 先置空，后面统一修正
        timestamp: msg.timestamp, // 保留原始时间戳
      };
    }
    // 修正 parentId
    for (const [oldId, newId] of idMap) {
      const oldMsg = original.messageTree[oldId];
      if (oldMsg.parentId && idMap.has(oldMsg.parentId)) {
        newMessageTree[newId].parentId = idMap.get(oldMsg.parentId)!;
      }
    }

    const newId = crypto.randomUUID();
    const now = Date.now();
    const newSession: Session = {
      ...original,
      id: newId,
      title: original.title,
      messageTree: newMessageTree,
      rootMessageId: original.rootMessageId ? (idMap.get(original.rootMessageId) ?? null) : null,
      execLeafId: original.execLeafId ? (idMap.get(original.execLeafId) ?? null) : null,
      viewLeafId: original.viewLeafId ? (idMap.get(original.viewLeafId) ?? null) : null,
      createdAt: now,
      updatedAt: now,
      isStreaming: false,
      isAgentRunning: false,
      isQueued: false,
      isRateLimited: false,
      hasUnread: false,
      abortController: null,
      currentTool: null,
      draft: original.draft ?? '',
      // 深拷贝配置对象，避免共享引用
      llmConfig: { ...original.llmConfig },
      mcpConfig: { ...original.mcpConfig },
    };

    // 插入到原会话之后
    const originalIndex = state.sessionOrder.indexOf(sessionId);
    const newOrder = [...state.sessionOrder];
    newOrder.splice(originalIndex + 1, 0, newId);

    set({
      sessions: { ...state.sessions, [newId]: newSession },
      sessionOrder: newOrder,
    });
    markSessionDirty(newId);
    return newId;
  },

  renameSession: (sessionId, title) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          title,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  /** 更新指定会话的输入框草稿文本，页面切换后恢复用 */
  updateSessionDraft: (sessionId, draft) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    // 仅在 draft 变化时才 set，避免不必要的重渲染
    if (session.draft === draft) return;
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          draft,
        },
      },
    }));
    // 🚀 性能优化：草稿变更只写入 sessionStorage（轻量热备份），不触发全量持久化
    // saveChatHistory 会遍历所有 session 的所有消息做序列化 + 一致性检查，开销极大
    // sessionStorage 在 HMR / 页面刷新后仍可恢复草稿内容，完全关闭标签页再打开时 draft 丢失可接受
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        const state = get();
        const sessionData = {
          sessions: { [sessionId]: { ...state.sessions[sessionId] } },
          sessionOrder: state.sessionOrder,
          currentSessionId: state.currentSessionId,
        };
        sessionStorage.setItem('chat-draft-session', JSON.stringify(sessionData));
      } catch (e) {
        console.warn('[chatStore] sessionStorage draft 写入失败:', e);
      }
      draftTimer = null;
    }, 1000);
  },

  // ── 消息操作 ─────────────────────────────────────────────

  addMessage: (sessionId, message) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const parentId = session.execLeafId;
    const newMessage: Message = {
      ...message,
      id: crypto.randomUUID(),
      parentId,
      timestamp: Date.now(),
    };

    // ✅ 工具结果：递减待处理 toolCall 计数
    const isToolResult = message.role === 'tool';
    // ✅ 新一轮 assistant：重置 toolCall 追踪（上一轮已结束）
    const isNewAssistant = message.role === 'assistant';

    const updatedSession: Session = {
      ...session,
      messageTree: { ...session.messageTree, [newMessage.id]: newMessage },
      rootMessageId: session.rootMessageId ?? newMessage.id,
      execLeafId: newMessage.id,
      // 流式期间：若用户正在浏览其他分支，保持视图不动；
      // 若用户就在执行分支上，视图跟随执行锚点前进（否则看不到新气泡）
      viewLeafId: (session.isStreaming || session.isAgentRunning) && session.viewLeafId !== session.execLeafId
        ? session.viewLeafId
        : newMessage.id,
      // ✅ 工具结果到达：递减计数；新一轮 assistant：重置追踪
      pendingToolCallCount: isToolResult
        ? Math.max(0, (session.pendingToolCallCount ?? 0) - 1)
        : isNewAssistant
          ? 0
          : session.pendingToolCallCount,
      currentAssistantId: isNewAssistant ? newMessage.id : session.currentAssistantId,
      updatedAt: Date.now(),
    };

    // 如果是第一条用户消息且标题为默认值，先使用内容截取作为临时标题
    // （异步调用 LLM 自动命名现已移至 useChat.sendMessage 中触发）
    const isFirstUserMessage =
      message.role === 'user' &&
      !Object.values(session.messageTree).some(m => m.role === 'user') &&
      session.title.startsWith('新对话');

    if (isFirstUserMessage) {
      // 先用内容截取作为临时标题（立即可见）
      updatedSession.title = generateTitle(message.content);
    }

    set((state) => ({
      sessions: { ...state.sessions, [sessionId]: updatedSession },
      sessionOrder: [
        sessionId,
        ...state.sessionOrder.filter((id) => id !== sessionId),
      ],
    }));

    // 标记会话为脏，1 秒后统一持久化
    markSessionDirty(sessionId);

    return newMessage.id;
  },

  updateLastMessage: (sessionId, content) => {
    const session = get().sessions[sessionId];
    if (!session || session.execLeafId === null) return;

    const buf = getBuffer(sessionId);
    buf.content += content;
    // 标记缓冲区有待 flush 内容，外部观察者可订阅此状态
    if (!session.flushPending) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], flushPending: true },
        },
      }));
    }
    scheduleFlush(sessionId);
  },

  updateLastMessageReasoning: (sessionId, chunk) => {
    const session = get().sessions[sessionId];
    if (!session || session.execLeafId === null) return;

    const buf = getBuffer(sessionId);
    buf.reasoning += chunk;
    if (!session.flushPending) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], flushPending: true },
        },
      }));
    }
    scheduleFlush(sessionId);
  },

  clearMessages: (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    // 保留 system 根节点，仅清除其余消息
    const systemNode = Object.values(session.messageTree)
      .find(m => m.parentId === null && m.role === 'system');

    if (systemNode) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: { [systemNode.id]: systemNode },
            rootMessageId: systemNode.id,
            execLeafId: systemNode.id,
            viewLeafId: systemNode.id,
            updatedAt: Date.now(),
          },
        },
      }));
    } else {
      // 兜底：无 system 根节点时清空整棵树
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: {},
            rootMessageId: null,
            execLeafId: null,
            viewLeafId: null,
            updatedAt: Date.now(),
          },
        },
      }));
    }
    markSessionDirty(sessionId);
  },

  deleteMessage: (sessionId, id) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const deletedMsg = session.messageTree[id];
    if (!deletedMsg) return;

    // 禁止删除 system 根节点（快捷键、清空对话等路径可能误触）
    if (deletedMsg.role === 'system' && deletedMsg.parentId === null) return;

    // 如果删除了根消息（parentId === null），清空整个会话
    if (deletedMsg.parentId === null) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: {},
            rootMessageId: null,
            execLeafId: null,
            viewLeafId: null,
            updatedAt: Date.now(),
          },
        },
      }));
      markSessionDirty(sessionId);
      return;
    }

    // ── 单分支非叶子节点：摘除中间节点，父节点与子节点直接相连 ──
    // 注意：携带 toolCalls 的 assistant 消息，其工具返回值（tool 消息）是其子节点，
    // 删除 assistant 时必须连同子节点一起删除，不能做 splice 摘除。
    const hasToolCalls = deletedMsg.role === 'assistant' && deletedMsg.toolCalls && deletedMsg.toolCalls.length > 0;
    const directChildren = Object.values(session.messageTree).filter(m => m.parentId === id);
    if (directChildren.length === 1 && !hasToolCalls) {
      // 只有一个直接子节点 → 摘除本节点，子节点上移接替位置
      const child = directChildren[0];
      const newTree = {
        ...session.messageTree,
        [child.id]: { ...child, parentId: deletedMsg.parentId },
      };
      delete newTree[id];

      // 处理 execLeafId
      let newExecLeafId = session.execLeafId;
      if (!newExecLeafId || !newTree[newExecLeafId]) {
        // execLeafId 指向被删节点（不在新树中），切换到子分支的首个叶子
        const childLeaves = getChildLeaves(newTree, child.id);
        newExecLeafId = childLeaves.length > 0 ? childLeaves[0] : child.id;
      }
      // 若 execLeafId 在子节点的子树中（含子节点本身），保持不变，
      // 因 parentId 已更新，回溯路径依然正确

      // 处理 viewLeafId（可能与 execLeafId 不同，流式期间用户可能在浏览其他分支）
      let newViewLeafId = session.viewLeafId;
      if (!newViewLeafId || !newTree[newViewLeafId]) {
        const childLeaves = getChildLeaves(newTree, child.id);
        newViewLeafId = childLeaves.length > 0 ? childLeaves[0] : child.id;
      }

      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: newTree,
            execLeafId: newExecLeafId,
            viewLeafId: newViewLeafId,
            updatedAt: Date.now(),
          },
        },
      }));
      markSessionDirty(sessionId);
      return;
    }

    // ── 多分支节点或叶子节点：整棵子树删除 ──
    const newTree = removeSubtree(session.messageTree, id);

    // 处理 execLeafId
    let newExecLeafId2 = session.execLeafId;
    if (!newExecLeafId2 || !newTree[newExecLeafId2]) {
      // 优先切换到兄弟分支（如果有），避免用户"卡"在父节点看不到其他分支
      const siblingLeaves = getChildLeaves(newTree, deletedMsg.parentId);
      newExecLeafId2 = siblingLeaves.length > 0 ? siblingLeaves[0] : deletedMsg.parentId;
    }

    // 处理 viewLeafId（可能与 execLeafId 不同）
    let newViewLeafId2 = session.viewLeafId;
    if (!newViewLeafId2 || !newTree[newViewLeafId2]) {
      // 回退到父节点（而非兄弟分支），避免流式期间跳到执行分支
      newViewLeafId2 = deletedMsg.parentId;
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: newTree,
          execLeafId: newExecLeafId2,
          viewLeafId: newViewLeafId2,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  /** 批量删除消息：
   *  1. 自动过滤后代节点（只保留最顶层的选中节点）
   *  2. 禁止删除 system 根节点
   *  3. 正确处理根节点（清空会话）、分支节点（整棵子树）、叶子节点、中间节点 */
  deleteMessages: (sessionId, ids) => {
    const session = get().sessions[sessionId];
    if (!session || ids.length === 0) return;

    // ── 过滤：只保留顶层节点（其祖先不在 ids 中的节点） ──
    const topmost = ids.filter((id) => {
      const msg = session.messageTree[id];
      if (!msg) return false;
      let current = msg.parentId;
      while (current) {
        if (ids.includes(current)) return false;
        const parent = session.messageTree[current];
        if (!parent) break;
        current = parent.parentId;
      }
      return true;
    });

    if (topmost.length === 0) return;

    let tree = { ...session.messageTree };
    let execLeaf = session.execLeafId;
    let viewLeaf = session.viewLeafId;
    let sessionCleared = false;

    for (const id of topmost) {
      const msg = tree[id];
      if (!msg) continue;

      // 禁止删除 system 根节点
      if (msg.role === 'system' && msg.parentId === null) continue;

      // 根节点（parentId === null）→ 清空整个会话
      if (msg.parentId === null) {
        tree = {};
        execLeaf = null;
        viewLeaf = null;
        sessionCleared = true;
        break;
      }

      // ── 单分支非叶子节点：摘除中间节点，父节点与子节点直接相连 ──
      // 注意：携带 toolCalls 的 assistant 消息，其工具返回值（tool 消息）是其子节点，
      // 删除 assistant 时必须连同子节点一起删除，不能做 splice 摘除。
      const directChildren = Object.values(tree).filter((m) => m.parentId === id);
      const msgHasToolCalls = msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0;
      if (directChildren.length === 1 && !msgHasToolCalls) {
        const child = directChildren[0];
        // 摘除本节点，子节点上移
        tree = { ...tree, [child.id]: { ...child, parentId: msg.parentId } };
        delete tree[id];
        // 如果子节点也在待删列表中，沿单分支链继续摘除
        // （避免 removeSubtree 误删更深的后代节点）
        if (ids.includes(child.id)) {
          let chainId = child.id;
          while (true) {
            const chainMsg = tree[chainId];
            if (!chainMsg) break;
            const chainChildren = Object.values(tree).filter(m => m.parentId === chainId);
            const chainHasTC = chainMsg.role === 'assistant' && chainMsg.toolCalls && chainMsg.toolCalls.length > 0;
            if (chainChildren.length === 1 && !chainHasTC && ids.includes(chainChildren[0].id)) {
              const nextChild = chainChildren[0];
              tree = { ...tree, [nextChild.id]: { ...nextChild, parentId: chainMsg.parentId } };
              delete tree[chainId];
              chainId = nextChild.id;
            } else {
              break;
            }
          }
        }
      } else {
        // 多分支节点或叶子节点：整棵子树删除
        tree = removeSubtree(tree, id);
      }

      // 分别更新 execLeafId 和 viewLeafId（流式期间可能不同）
      if (execLeaf && !tree[execLeaf]) {
        const siblingLeaves = getChildLeaves(tree, msg.parentId);
        execLeaf = siblingLeaves.length > 0 ? siblingLeaves[0] : msg.parentId;
      }
      if (viewLeaf && !tree[viewLeaf]) {
        // 回退到父节点（而非兄弟分支），避免流式期间跳到执行分支
        viewLeaf = msg.parentId;
      }
    }

    // 确保 rootMessageId 仍然有效
    let rootId = session.rootMessageId;
    if (sessionCleared) {
      rootId = null;
    } else if (rootId && !tree[rootId]) {
      rootId = null;
      execLeaf = null;
      viewLeaf = null;
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: tree,
          rootMessageId: rootId,
          execLeafId: execLeaf,
          viewLeafId: viewLeaf,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  editMessage: (sessionId, id, content, toolResult) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: session.messageTree[id]
            ? {
                ...session.messageTree,
                [id]: {
                  ...session.messageTree[id],
                  content,
                  ...(toolResult !== undefined ? { toolResult } : {}),
                },
              }
            : session.messageTree,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  updateMessageRole: (sessionId, id, role) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: session.messageTree[id]
            ? { ...session.messageTree, [id]: { ...session.messageTree[id], role } }
            : session.messageTree,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  truncateMessagesAfter: (sessionId, id) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const targetMsg = session.messageTree[id];
    if (!targetMsg) return;

    // 🔧 清除流式缓冲区：截断消息树后，旧缓冲区内容已属于被删除的消息，
    //    若不清理，残留内容会在下一轮 doStream 中被 flushSessionUpdates
    //    或 scheduleFlush 错误地写入新 assistant，导致"瞬间生成"假象。
    const buf = streamBuffers.get(sessionId);
    if (buf) {
      buf.content = '';
      buf.reasoning = '';
      buf.toolCalls = null;
      buf.flushScheduled = false;
    }

    // 如果目标是 assistant 且有 toolCalls，保留工具返回值子树，
    // 只删除工具链之后的内容（如模型的最终文本回复），然后从那里继续生成。
    if (targetMsg.role === 'assistant' && targetMsg.toolCalls && targetMsg.toolCalls.length > 0) {
      // 沿工具链向下找到最后一个 tool 消息
      let lastToolId = id;
      let currentId = id;
      while (true) {
        const children = Object.values(session.messageTree).filter(m => m.parentId === currentId);
        // 取第一个子节点（工具链在单分支路径上是连续的）
        if (children.length === 0) break;
        const firstChild = children[0];
        if (firstChild.role === 'tool') {
          lastToolId = firstChild.id;
          currentId = firstChild.id;
        } else {
          break;
        }
      }

      // 从最后一个工具消息之后截断：删掉它的后代（模型的后续回复等），保留工具消息本身
      const newTree = removeSubtree(session.messageTree, lastToolId);
      newTree[lastToolId] = session.messageTree[lastToolId];
      // 保持 toolCalls 不变（工具返回值保留，后续 LLM 可以据此继续生成）

      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: newTree,
            execLeafId: lastToolId,
            // 截断的是执行路径，视图路径保持不变（用户可能在浏览其他分支）
            viewLeafId: (session.isStreaming || session.isAgentRunning) ? session.viewLeafId : lastToolId,
            updatedAt: Date.now(),
          },
        },
      }));
      markSessionDirty(sessionId);
      return;
    }

    // 非 toolCalls 的 assistant 或其他消息：删除目标消息之后的所有子节点（保留目标本身）
    const newTree = removeSubtree(session.messageTree, id);
    newTree[id] = targetMsg;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: newTree,
          execLeafId: id,
          // 截断的是执行路径，视图路径保持不变
          viewLeafId: (session.isStreaming || session.isAgentRunning) ? session.viewLeafId : id,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  forkFrom: (sessionId, sourceMsgId, role) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const sourceMsg = session.messageTree[sourceMsgId];
    if (!sourceMsg) return;
    // 不能对根消息（parentId=null）进行分支，因为没有"同级"概念
    if (sourceMsg.parentId === null) return;

    const newMessage: Message = {
      id: crypto.randomUUID(),
      parentId: sourceMsg.parentId,
      role,
      content: '',
      timestamp: Date.now(),
    };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: { ...session.messageTree, [newMessage.id]: newMessage },
          execLeafId: session.isStreaming || session.isAgentRunning ? session.execLeafId : newMessage.id,
          viewLeafId: newMessage.id,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  addChildMessage: (sessionId, sourceMsgId, role, content) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const sourceMsg = session.messageTree[sourceMsgId];
    if (!sourceMsg) return;

    const newMessage: Message = {
      id: crypto.randomUUID(),
      parentId: sourceMsgId,
      role,
      content: content ?? '',
      timestamp: Date.now(),
    };

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: { ...session.messageTree, [newMessage.id]: newMessage },
          execLeafId: session.isStreaming || session.isAgentRunning ? session.execLeafId : newMessage.id,
          viewLeafId: newMessage.id,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  switchBranch: (sessionId, leafId) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    if (!session.messageTree[leafId]) return;

    const isProcessing = session.isStreaming || session.isAgentRunning;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          viewLeafId: leafId,
          // 流式期间：执行锚点不动，只切换视图
          execLeafId: isProcessing ? session.execLeafId : leafId,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  truncateMessagesFrom: (sessionId, id) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    if (!session.messageTree[id]) return;

    const deletedMsg = session.messageTree[id];

    // 如果删除了根消息，清空整个会话
    if (deletedMsg.parentId === null) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: {},
            rootMessageId: null,
            execLeafId: null,
            viewLeafId: null,
            updatedAt: Date.now(),
          },
        },
      }));
      markSessionDirty(sessionId);
      return;
    }

    const newTree = removeSubtree(session.messageTree, id);

    // 处理 execLeafId
    let newExecLeafId = session.execLeafId;
    if (!newExecLeafId || !newTree[newExecLeafId]) {
      newExecLeafId = deletedMsg.parentId;
    }

    // 处理 viewLeafId（可能与 execLeafId 不同）
    let newViewLeafId = session.viewLeafId;
    if (!newViewLeafId || !newTree[newViewLeafId]) {
      newViewLeafId = deletedMsg.parentId;
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: newTree,
          execLeafId: newExecLeafId,
          viewLeafId: newViewLeafId,
          updatedAt: Date.now(),
        },
      },
    }));
    markSessionDirty(sessionId);
  },

  // ── 智能体绑定（方法名保留 setSessionRole/moveSession 旧名） ──

  setSessionRole: (sessionId, agentId) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    // ── 更新 system 根节点内容为新智能体的提示词 ──
    const systemMsg = Object.values(session.messageTree)
      .find(m => m.parentId === null && m.role === 'system');
    const roles = useSettingsStore.getState().roles;
    const role = roles.find(r => r.id === agentId);
    const newPrompt = role?.systemPrompt?.trim() || '';

    const updatedTree = systemMsg
      ? { ...session.messageTree, [systemMsg.id]: { ...systemMsg, content: newPrompt } }
      : session.messageTree;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, messageTree: updatedTree, agentId },
      },
    }));
    markSessionDirty(sessionId);
  },

  /**
   * 将智能体的最新系统提示词同步到所有使用该智能体的会话的 system 根节点。
   * 编辑智能体提示词后调用。
   */
  syncSystemPrompts: (agentId) => {
    const { sessions } = get();
    const roles = useSettingsStore.getState().roles;
    const role = roles.find(r => r.id === agentId);
    const newPrompt = role?.systemPrompt?.trim() || '';
    let changed = false;

    const updated: Record<string, Session> = {};
    for (const [sid, session] of Object.entries(sessions)) {
      if (session.agentId !== agentId) {
        updated[sid] = session;
        continue;
      }
      const systemMsg = Object.values(session.messageTree)
        .find(m => m.parentId === null && m.role === 'system');
      if (!systemMsg) {
        updated[sid] = session;
        continue;
      }
      updated[sid] = {
        ...session,
        messageTree: {
          ...session.messageTree,
          [systemMsg.id]: { ...systemMsg, content: newPrompt },
        },
      };
      changed = true;
    }

    if (changed) {
      set({ sessions: updated });
      // 标记所有受影响会话为脏
      for (const [sid, session] of Object.entries(updated)) {
        if (session.agentId === agentId) {
          markSessionDirty(sid);
        }
      }
    }
  },

  moveSession: (sessionId, targetAgentId, afterSessionId) => {
    const { sessions, sessionOrder } = get();
    const session = sessions[sessionId];
    if (!session) return;

    const isStarred = !!session.isStarred;

    // ── 更新 agentId + system 根节点内容 ──
    const roles = useSettingsStore.getState().roles;
    const targetRole = roles.find(r => r.id === targetAgentId);
    const newPrompt = targetRole?.systemPrompt?.trim() || '';
    const systemMsg = Object.values(session.messageTree)
      .find(m => m.parentId === null && m.role === 'system');
    const updatedTree = systemMsg
      ? { ...session.messageTree, [systemMsg.id]: { ...systemMsg, content: newPrompt } }
      : session.messageTree;
    const updatedSession: Session = { ...session, agentId: targetAgentId, messageTree: updatedTree };

    // 从当前位置移除
    const order = sessionOrder.filter((id) => id !== sessionId);

    // 计算插入位置
    let insertIndex: number;
    if (afterSessionId === null) {
      // 插到组最前：找该组在剩余 order 中的第一个 session
      const firstInGroup = order.findIndex((id) => sessions[id]?.agentId === targetAgentId);
      if (firstInGroup === -1) {
        // 该组为空
        insertIndex = 0;
      } else if (isStarred) {
        // 关注会话：插入到该组最前（所有关注之前）
        insertIndex = firstInGroup;
      } else {
        // 未关注会话：插入到该组最后一个关注会话之后
        let lastStarred = -1;
        for (let i = firstInGroup; i < order.length; i++) {
          const s = sessions[order[i]];
          if (s?.agentId !== targetAgentId) break;
          if (s?.isStarred) lastStarred = i;
        }
        insertIndex = lastStarred === -1 ? firstInGroup : lastStarred + 1;
      }
    } else {
      const afterIndex = order.indexOf(afterSessionId);
      if (afterIndex === -1) {
        insertIndex = order.length;
      } else {
        insertIndex = afterIndex + 1;
      }

      // 安全检查：确保关注/未关注的边界不被跨越
      // 找该组中最后一个关注会话的索引
      let lastStarredIdx = -1;
      let firstNonStarredIdx = -1;
      for (let i = 0; i < order.length; i++) {
        const s = sessions[order[i]];
        if (s?.agentId !== targetAgentId) continue;
        if (s?.isStarred) {
          lastStarredIdx = i;
        } else if (firstNonStarredIdx === -1) {
          firstNonStarredIdx = i;
        }
      }

      if (isStarred && firstNonStarredIdx >= 0 && insertIndex > firstNonStarredIdx) {
        // 关注会话不能插入到未关注区域，强制放到最末关注之后
        insertIndex = lastStarredIdx >= 0 ? lastStarredIdx + 1 : firstNonStarredIdx;
        // 如果 afterSessionId 本身在未关注区域，回退到组内关注末尾
        // 实际上算出的 insertIndex 已经正确，无需额外处理
      } else if (!isStarred && lastStarredIdx >= 0 && insertIndex <= lastStarredIdx) {
        // 未关注会话不能插入到关注区域，强制放到最末关注之后
        insertIndex = lastStarredIdx + 1;
      }
    }

    order.splice(insertIndex, 0, sessionId);

    set({
      sessions: { ...sessions, [sessionId]: updatedSession },
      sessionOrder: order,
    });
    markSessionDirty(sessionId);
  },

  /**
   * 重排指定智能体组内的会话顺序（Framer Motion Reorder 回调）
   * 保持全局 sessionOrder 中非该组的部分不变，
   * 仅替换该组内的关注区/未关注区顺序
   */
  reorderSessions: (agentId, starred, unstarred) => {
    const { sessionOrder } = get();
    const groupIds = new Set([...starred, ...unstarred]);
    const otherOrder = sessionOrder.filter((id) => !groupIds.has(id));
    // 找到插入点：原始 order 中该组第一个 session 的位置
    const firstGroupIdx = sessionOrder.findIndex((id) => groupIds.has(id));
    let insertIdx = firstGroupIdx >= 0 ? firstGroupIdx : otherOrder.length;
    if (insertIdx > otherOrder.length) insertIdx = otherOrder.length;
    // 构建新 order
    const newOrder = [
      ...otherOrder.slice(0, insertIdx),
      ...starred,
      ...unstarred,
      ...otherOrder.slice(insertIdx),
    ];
    set({ sessionOrder: newOrder });
    scheduleSave();
  },

  // ── 星标关注 ─────────────────────────────────────────────

  toggleStarSession: (sessionId) => {
    const { sessions, sessionOrder } = get();
    const session = sessions[sessionId];
    if (!session) return;

    const newStarred = !session.isStarred;
    const agentId = session.agentId;
    const newOrder = sessionOrder.filter((id) => id !== sessionId);

    if (newStarred) {
      // 关注：移到该智能体组内最后一个已关注会话之后（即关注区末尾）
      let lastStarredIdx = -1;
      for (let i = 0; i < newOrder.length; i++) {
        const s = sessions[newOrder[i]];
        if (s?.agentId === agentId && s?.isStarred) {
          lastStarredIdx = i;
        } else if (s?.agentId === agentId && !s?.isStarred && lastStarredIdx >= 0) {
          // 已进入未关注区，不再继续查找
          break;
        }
      }
      newOrder.splice(lastStarredIdx + 1, 0, sessionId);
    } else {
      // 取消关注：移到该智能体组内未关注区的最前面
      let insertIdx = newOrder.length;
      for (let i = 0; i < newOrder.length; i++) {
        const s = sessions[newOrder[i]];
        if (s?.agentId === agentId) {
          if (!s?.isStarred) {
            insertIdx = i;
            break;
          }
          insertIdx = i + 1; // 最后一个关注会话之后
        }
      }
      newOrder.splice(insertIdx, 0, sessionId);
    }

    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          isStarred: newStarred,
          updatedAt: Date.now(),
        },
      },
      sessionOrder: newOrder,
    });
    markSessionDirty(sessionId);
  },

  updateSessionThinkingMode: (sessionId, mode) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          thinkingMode: mode,
          updatedAt: Date.now(),
        },
      },
    });
    markSessionDirty(sessionId);
  },

  updateSessionLLMConfig: (sessionId, config) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          llmConfig: config,
          updatedAt: Date.now(),
        },
      },
    });
    markSessionDirty(sessionId);
  },

  updateSessionMCPConfig: (sessionId, config) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          mcpConfig: config,
          updatedAt: Date.now(),
        },
      },
    });
    markSessionDirty(sessionId);
  },

  // ── 流式状态管理 ─────────────────────────────────────────

  setStreaming: (sessionId, isStreaming) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    // 方案 D：流式结束（true→false）时触发保存，弥补流式过程中跳过的持久化
    const wasStreaming = session.isStreaming;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          isStreaming,
          // ✅ 流式结束时清除 flushPending（flushSessionUpdates 会处理残留内容）
          flushPending: isStreaming ? session.flushPending : false,
          // 流式结束时若用户未在查看该会话，标记未读
          ...(wasStreaming && !isStreaming && state.currentSessionId !== sessionId
            ? { hasUnread: true }
            : {}),
        },
      },
    }));

    if (wasStreaming && !isStreaming) {
      // 先 flush 残留的 pending chunks，确保保存时内容完整
      flushSessionUpdates(sessionId);
      markSessionDirty(sessionId);
    }
  },

  setAgentRunning: (sessionId, isAgentRunning) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const wasAgentRunning = session.isAgentRunning;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          isAgentRunning,
          // 工具执行结束时若用户未在查看该会话，标记未读
          ...(wasAgentRunning && !isAgentRunning && state.currentSessionId !== sessionId
            ? { hasUnread: true }
            : {}),
        },
      },
    }));
  },

  setRateLimited: (sessionId, isRateLimited) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          isRateLimited,
        },
      },
    }));
  },

  setAbortController: (sessionId, controller) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          abortController: controller,
        },
      },
    }));
  },

  // 🆕 多流并行：登记一个新流
  registerStream: (sessionId, stream) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const newStreams = new Map(session.activeStreams);
    newStreams.set(stream.execLeafId, stream);

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          activeStreams: newStreams,
        },
      },
    }));
  },

  // 🆕 多流并行：注销一个流
  unregisterStream: (sessionId, execLeafId) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const newStreams = new Map(session.activeStreams);
    newStreams.delete(execLeafId);

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          activeStreams: newStreams,
        },
      },
    }));

    // 清理该流的 buffer（防止残留内容污染后续流）
    streamBuffers.delete(`${sessionId}::${execLeafId}`);
  },

  setLastMessageTokenUsage: (sessionId, usage) => {
    const session = get().sessions[sessionId];
    if (!session || session.execLeafId === null) return;

    const leafMsg = session.messageTree[session.execLeafId];
    // 防御性检查：只写入 assistant 消息（MCP 多轮场景下最后一条可能是 tool 消息）
    if (!leafMsg || leafMsg.role !== 'assistant') return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messageTree: {
            ...session.messageTree,
            [leafMsg.id]: { ...leafMsg, tokenUsage: usage },
          },
        },
      },
    }));
  },

  setLastMessageToolCalls: (sessionId, toolCalls) => {
    // 🛡️ 防御：拒绝空数组，防止 tool_calls: [] 被写入消息并最终传给 API 导致 400
    if (!toolCalls || toolCalls.length === 0) return;

    const session = get().sessions[sessionId];
    if (!session || session.execLeafId === null) return;
    const leafMsg = session.messageTree[session.execLeafId];
    if (!leafMsg || leafMsg.role !== 'assistant') return;

    // 🟢 流式已结束（非流式状态）：同步直接写入 store，清理缓冲区残留，
    //    避免异步 rAF 写入时 execLeafId 已被 addMessage 改变导致跨轮错位。
    if (!session.isStreaming) {
      const buf = getBuffer(sessionId);
      buf.toolCalls = null;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messageTree: {
              ...session.messageTree,
              [leafMsg.id]: { ...leafMsg, toolCalls },
            },
            // ✅ 记录当前轮 assistant ID 和待处理 toolCall 数量
            currentAssistantId: leafMsg.id,
            pendingToolCallCount: toolCalls.length,
            updatedAt: Date.now(),
          },
        },
      }));
      return;
    }

    // 🟢 流式进行中（partial delta）：存入缓冲区并绑定当前消息 ID，
    //    由 scheduleFlush 在写入时校验消息 ID 是否匹配。
    const buf = getBuffer(sessionId);
    buf.toolCalls = { toolCalls, messageId: session.execLeafId };
    // ✅ 标记缓冲区有待 flush 内容 + 记录当前轮 assistant 和 toolCall 数量
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          flushPending: true,
          currentAssistantId: session.execLeafId,
          pendingToolCallCount: toolCalls.length,
        },
      },
    }));
    scheduleFlush(sessionId);
  },

  setSessionCurrentTool: (sessionId, tool) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, currentTool: tool },
      },
    }));
  },

  // ── 排队状态 ──────────────────────────────────────────

  setQueued: (sessionId, isQueued, queuedFiles, queuedDirs, queuedHolderIds) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          isQueued,
          queuedFiles: queuedFiles || [],
          queuedDirs: queuedDirs || [],
          queuedHolderIds: queuedHolderIds || [],
        },
      },
    }));
  },

  // ── 持久化 ───────────────────────────────────────────────

  loadChatHistory: async () => {
    await loadChatHistoryImpl(get, set);
  },

  saveChatHistory: async () => {
    await saveChatHistoryImpl(get);
  },

  // ── 清理 ───────────────────────────────────────────────

  cleanup: () => {
    // 清理草稿定时器
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }

    // 重置保存并发控制标志
    resetSavingState();

    // 清理所有会话的流式缓冲区
    streamBuffers.clear();

    // 清理滚动缓存（🐛 内存泄漏修复：应用卸载时清空所有模块级滚动状态）
    clearAllScrollCache();

    // 中止所有进行中的流式请求
    const { sessions } = get();
    for (const session of Object.values(sessions)) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }
  },
}; });

// ── 导出工具函数 ──────────────────────────────────────────

/**
 * 立即 flush 指定会话的 pending chunks，将累积内容写入最后一条 assistant 消息。
 *
 * 在 MCP Agentic Loop 中，每轮流结束后到下一轮开始前，需要主动调用此函数，
 * 确保上一轮的 pending chunks 不会残留到下一轮，避免跨轮内容错位。
 *
 * 委托给统一的 flushBuffer(sessionId, 'sync')，与 scheduleFlush 的 async 路径
 * 共享相同的：找 assistant → 校验 toolCalls → 消费缓冲区 → 写入 store 逻辑。
 *
 * @param sessionId 目标会话 ID
 */
export function flushSessionUpdates(sessionId: string): boolean {
  if (!_flushBuffer) return false;
  return _flushBuffer(sessionId, 'sync');
}

/**
 * 订阅会话的"轮次结束"事件。当满足以下任一条件时触发回调（仅一次，触发后自动取消订阅）：
 *
 *   ① isStreaming 从 true→false 且 flushPending=false 且 pendingToolCallCount=0（本轮完整结束）
 *   ② isStreaming 从 false→true（下一轮已开始，本轮肯定结束）
 *   ③ isAgentRunning 从 true→false 且 !isStreaming（整个 Loop 结束）
 *   ④ session 被删除
 *
 * 用于 auto-commit 通知、会话恢复等需要"等当前轮结束"的场景，
 * 替代轮询和手动 subscribe 拼接。
 *
 * @param sessionId 目标会话 ID
 * @param callback  轮次结束时回调（同步执行）
 * @returns         取消订阅函数（在回调触发前调用可阻止回调）
 */
export function onRoundEnd(sessionId: string, callback: () => void): () => void {
  // 快速路径：已空闲则立即触发
  const state = useChatStore.getState();
  const session = state.sessions[sessionId];
  if (!session) {
    // session 不存在，下一微任务触发（让调用方有机会处理）
    Promise.resolve().then(callback);
    return () => {};
  }

  const isIdle =
    !session.isStreaming &&
    !session.isAgentRunning &&
    !session.flushPending &&
    (session.pendingToolCallCount ?? 0) === 0;

  if (isIdle) {
    Promise.resolve().then(callback);
    return () => {};
  }

  const unsub = useChatStore.subscribe((newState, prevState) => {
    const s = newState.sessions[sessionId];
    const ps = prevState.sessions[sessionId];

    if (!s) { unsub(); callback(); return; }

    const wasStreaming = ps?.isStreaming ?? false;
    const isNowStreaming = s.isStreaming ?? false;
    const wasAgentRunning = ps?.isAgentRunning ?? false;
    const isNowAgentRunning = s.isAgentRunning ?? false;
    const wasFlushPending = ps?.flushPending ?? false;
    const isNowFlushPending = s.flushPending ?? false;
    const prevToolCount = ps?.pendingToolCallCount ?? 0;
    const nowToolCount = s.pendingToolCallCount ?? 0;

    // 条件 ①：本轮完整结束
    const roundComplete =
      wasStreaming && !isNowStreaming &&
      !isNowFlushPending &&
      nowToolCount === 0;

    // 条件 ②：下一轮已开始
    const nextRoundStarted =
      !wasStreaming && isNowStreaming;

    // 条件 ③：整个 Loop 结束
    const loopEnded =
      wasAgentRunning && !isNowAgentRunning &&
      !isNowStreaming;

    // 条件 ④：流结束 + flushPending 从 true→false
    const streamingEndedNoTools =
      wasStreaming && !isNowStreaming &&
      !isNowFlushPending &&
      wasFlushPending &&
      nowToolCount === 0;

    if (roundComplete || nextRoundStarted || loopEnded || streamingEndedNoTools) {
      unsub();
      callback();
    }
  });

  return unsub;
}
