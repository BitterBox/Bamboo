// ============================================================
// sessionRecovery — 会话恢复判定与执行（纯函数，无 React 依赖）
//
// 实际架构（三条防线，各管一摊）：
//
//   Vite 热更新 ──┬── partial HMR（非 batch_commit）
//                 │   → window.__ZUSTAND_CHAT_STORE__ 保护 store 实例
//                 │   → 流式不中断，无需恢复（预防机制）
//                 │
//                 └── batch_commit 触发的文件写入
//                     │
//                     ├── 路径 A：full-reload
//                     │   触发：新渲染进程挂载 → useSessionRecovery
//                     │   数据：主进程 recoveryList（IPC，跨进程存活）
//                     │   节奏：串行 await，逐个恢复
//                     │
//                     └── 路径 B：partial HMR（同进程内）
//                         触发：batch_commit 完成后 → checkStalledSessions
//                         数据：渲染进程内存 sessionsSnapshot（同进程）
//                         节奏：并发 fire-and-forget
//
// 两条路径共享同一套判定+执行管道：
//   - assessSessionForRecovery：五个检查线性排列，不区分场景
//   - executeRecovery：skip / restart / repair 三态执行
//
// 五个检查：
//   ① 会话存在？
//   ② 会话是否还在跑？（isStreaming / isAgentRunning）
//   ③ 消息是否在提交后发生了变化？（msgChanged）
//   ④ 恢复点是否有效？
//   ⑤ 消息树是否完整？（isAssistantComplete → repair）
// ============================================================

import { useChatStore, flushSessionUpdates } from '../store/chatStore';
import { resetSavingState, markSessionDirty } from '../store/persistence';
import { getActivePath, removeSubtree } from '../utils/treeUtils';
import type { Message } from '../types';

// ── 类型定义 ──────────────────────────────────────────────

export interface SessionSnapshot {
  sessionId: string;
  execLeafId: string;
  sourceCommit: boolean;
  lastMessageId: string;
}

export type RecoveryVerdict =
  | { action: 'skip'; reason: string }
  | { action: 'restart'; sessionId: string; resumeFrom: string }
  | {
      action: 'repair';
      sessionId: string;
      resumeFrom: string;
      lastAssistant: Message;
      synthesized: Message[];
      sourceCommit: boolean;
    };

// ── 恢复执行器（模块级，由 useSessionRecovery 注册）──────

let recoveryExecutor: ((sessionId: string) => Promise<any>) | null = null;

export function setRecoveryExecutor(fn: (sessionId: string) => Promise<any>): void {
  recoveryExecutor = fn;
}

export function getRecoveryExecutor(): (sessionId: string) => Promise<any> {
  if (!recoveryExecutor) throw new Error('Recovery executor not registered');
  return recoveryExecutor;
}

// ── 日志 ──────────────────────────────────────────────────

export function recoveryLog(level: 'log' | 'warn' | 'error', message: string): void {
  console[level](message);
  if (typeof window !== 'undefined' && (window as any).electronAPI?.logToMain) {
    (window as any).electronAPI.logToMain(
      level,
      `[Resume] ${message.replace(/^\[Resume\]\s*/, '')}`,
    );
  }
}

// ── flushAndSave ──────────────────────────────────────────

/**
 * Flush 所有会话的 pending chunks 并保存到磁盘。
 * 由 batch_commit 工具执行函数调用（必须 await）。
 */
export async function flushAndSave(): Promise<void> {
  const storeState = useChatStore.getState();
  for (const sessionId of Object.keys(storeState.sessions)) {
    const hadPending = flushSessionUpdates(sessionId);
    if (hadPending) {
      markSessionDirty(sessionId);
    }
  }
  resetSavingState();
  await storeState.saveChatHistory();
}

// ── collectSessionSnapshot ────────────────────────────────

/**
 * 收集所有非空闲会话的快照，用于 Vite 刷新后恢复。
 * @param sourceSessionId 触发当前 batch_commit 的会话 ID
 */
export function collectSessionSnapshot(
  sourceSessionId?: string | null,
): SessionSnapshot[] {
  const storeState = useChatStore.getState();
  const snapshot: SessionSnapshot[] = [];

  for (const [sessionId, session] of Object.entries(storeState.sessions)) {
    if (session.isStreaming || session.isAgentRunning || session.isQueued) {
      snapshot.push({
        sessionId,
        execLeafId: session.execLeafId ?? session.rootMessageId ?? '',
        sourceCommit: sessionId === sourceSessionId,
        lastMessageId: session.execLeafId ?? session.rootMessageId ?? '',
      });
    }
  }

  return snapshot;
}

// ── isAssistantComplete ───────────────────────────────────

/**
 * 判断一个 assistant 消息是否已完成（所有 toolCall 都有对应 tool 结果）。
 */
export function isAssistantComplete(
  messageTree: Record<string, Message>,
  assistant: Message,
): boolean {
  if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
    return !!(assistant.content && assistant.content.trim().length > 0);
  }

  const toolCallIds = new Set(assistant.toolCalls.map((tc) => tc.id));
  for (const msg of Object.values(messageTree)) {
    if (msg.parentId === assistant.id && msg.role === 'tool' && msg.toolResult) {
      toolCallIds.delete(msg.toolResult.toolCallId);
    }
  }

  return toolCallIds.size === 0;
}

// ── synthesizeMissingCommitResults ────────────────────────

/**
 * 检查 assistant 是否有未完成的 batch_commit/clear_batch_cache 工具调用，
 * 若有则返回合成工具结果消息（不修改 store，由调用方通过 setState 写入）。
 *
 * 前提：调用方确保恢复清单非空（即 batch_commit 已在主进程执行成功）。
 */
function synthesizeMissingCommitResults(
  messageTree: Record<string, Message>,
  assistant: Message,
): Message[] {
  if (!assistant.toolCalls || assistant.toolCalls.length === 0) return [];

  const synthesized: Message[] = [];

  for (const tc of assistant.toolCalls) {
    if (tc.name !== 'batch_commit' && tc.name !== 'clear_batch_cache') continue;

    const hasResult = Object.values(messageTree).some(
      (m) =>
        m.parentId === assistant.id &&
        m.role === 'tool' &&
        m.toolResult?.toolCallId === tc.id,
    );
    if (hasResult) continue;

    const resultContent =
      tc.name === 'batch_commit'
        ? '批量提交已完成。所有暂存修改已在 Vite 刷新前写入磁盘，备份已归档。'
        : '暂存区已清空。';

    synthesized.push({
      id: crypto.randomUUID(),
      parentId: assistant.id,
      role: 'tool',
      content: resultContent,
      timestamp: Date.now(),
      toolResult: {
        toolCallId: tc.id,
        name: tc.name,
        result: resultContent,
        isError: false,
      },
    } as Message);
  }

  return synthesized;
}

// ═══════════════════════════════════════════════════════════
//  核心：统一恢复判定
// ═══════════════════════════════════════════════════════════

/**
 * 统一的会话恢复判定。
 *
 * 五个检查线性排列，不区分 full-reload / partial HMR：
 *   ① 会话存在？
 *   ② 会话是否还在跑？
 *   ③ 消息是否在提交后发生了变化？
 *   ④ 恢复点是否有效？
 *   ⑤ 消息树是否完整？
 */
export function assessSessionForRecovery(
  session: ReturnType<typeof useChatStore.getState>['sessions'][string] | undefined,
  entry: SessionSnapshot,
): RecoveryVerdict {
  // ① 会话存在？
  if (!session) {
    return { action: 'skip', reason: 'session-not-found' };
  }

  // ② 会话是否还在跑？
  //    full-reload 后：永远 false（磁盘不保存运行时状态）→ 通过
  //    partial HMR 后：连接没断 → true → 正确跳过
  //                   连接断了 → false → 通过，继续检查
  if (session.isStreaming || session.isAgentRunning) {
    return { action: 'skip', reason: 'already-running' };
  }

  // ③ 消息是否在提交后发生了变化？
  //    full-reload 后：两者都来自快照，必然相等 → 通过
  //    partial HMR 后：有新气泡 → 自然结束 → 跳过
  //                   没新气泡 → 被杀 → 通过，继续检查
  const msgChanged = session.execLeafId !== entry.lastMessageId;
  if (msgChanged) {
    return { action: 'skip', reason: 'naturally-ended' };
  }

  // ④ 恢复点是否有效？
  //    full-reload 后：磁盘状态可能缺节点 → 需要验证
  //    partial HMR 后：store 完好，必然有效 → 通过
  const resumeFrom = entry.execLeafId || session.rootMessageId;
  if (!resumeFrom || !session.messageTree[resumeFrom]) {
    return { action: 'skip', reason: 'no-resume-point' };
  }

  // ⑤ 消息树是否完整？
  //    full-reload 后：磁盘状态可能缺 tool 结果 → 核心检查
  //    partial HMR 后：也可能缺 tool 结果 → 双保险
  const activePath = getActivePath(session);
  let lastAssistant: Message | null = null;
  for (let i = activePath.length - 1; i >= 0; i--) {
    if (activePath[i].role === 'assistant') {
      lastAssistant = activePath[i];
      break;
    }
  }

  if (lastAssistant && !isAssistantComplete(session.messageTree, lastAssistant)) {
    const synthesized = entry.sourceCommit
      ? synthesizeMissingCommitResults(session.messageTree, lastAssistant)
      : [];
    return {
      action: 'repair',
      sessionId: entry.sessionId,
      resumeFrom,
      lastAssistant,
      synthesized,
      sourceCommit: !!entry.sourceCommit,
    };
  }

  // 全部通过 → 直接恢复
  return {
    action: 'restart',
    sessionId: entry.sessionId,
    resumeFrom,
  };
}

// ═══════════════════════════════════════════════════════════
//  核心：统一恢复执行
// ═══════════════════════════════════════════════════════════

/**
 * 执行恢复判定结果。
 *
 * - skip：仅日志
 * - restart：设置 execLeafId/viewLeafId → doStream
 * - repair：合成/回退 → 设置 execLeafId/viewLeafId → doStream
 *
 * @param verdict  assessSessionForRecovery 的输出
 * @param doStream streamNewResponse 函数
 * @param log      日志函数
 */
export async function executeRecovery(
  verdict: RecoveryVerdict,
  doStream: (sessionId: string) => Promise<any>,
  log: (level: 'log' | 'warn' | 'error', msg: string) => void,
): Promise<void> {
  if (verdict.action === 'skip') {
    return;
  }

  if (verdict.action === 'restart') {
    // 设置恢复点
    useChatStore.setState((prev) => {
      const s = prev.sessions[verdict.sessionId];
      if (!s) return prev;
      return {
        sessions: {
          ...prev.sessions,
          [verdict.sessionId]: { ...s, execLeafId: verdict.resumeFrom, viewLeafId: verdict.resumeFrom },
        },
      };
    });

    log('log', `[Resume] ▶ 恢复会话 ${verdict.sessionId}（从 ${verdict.resumeFrom.slice(-8)} 继续）`);
    await doStream(verdict.sessionId);
    return;
  }

  // ── repair 分支 ──────────────────────────────────────────
  const { sessionId, resumeFrom, lastAssistant, synthesized, sourceCommit } = verdict;
  let finalResumeFrom = resumeFrom;

  if (synthesized.length > 0) {
    // 写入合成结果到 store
    useChatStore.setState((prev) => {
      const s = prev.sessions[sessionId];
      if (!s) return prev;
      const tree = { ...s.messageTree };
      for (const msg of synthesized) tree[msg.id] = msg;
      return {
        sessions: {
          ...prev.sessions,
          [sessionId]: { ...s, messageTree: tree },
        },
      };
    });
    log('log', `[Resume]   🔧 已补全 ${synthesized.length} 个工具结果`);

    // 重新检查：合成后是否已完整？
    // 注意：lastAssistant 引用来自 setState 前，仅 .id 和 .parentId 有效
    const updatedState = useChatStore.getState();
    const updatedSession = updatedState.sessions[sessionId];
    if (updatedSession) {
      const updatedAssistant = updatedSession.messageTree[lastAssistant.id];
      if (
        updatedAssistant &&
        isAssistantComplete(updatedSession.messageTree, updatedAssistant)
      ) {
        // 完整 → 从最后一条合成结果之后继续
        finalResumeFrom = synthesized[synthesized.length - 1].id;
        log('log', `[Resume]   ✅ 轮次已完整，从 ${finalResumeFrom.slice(-8)} 继续`);
      } else {
        // 仍不完整（有其他缺失的工具调用）→ 回退删除
        // 使用 updatedSession.messageTree（含合成消息）
        const newTree = removeSubtree(updatedSession.messageTree, lastAssistant.id);
        const newLeaf = lastAssistant.parentId;
        log('log', `[Resume]   ✂ 轮次仍不完整，回退到 ${newLeaf || '(root)'}`);
        useChatStore.setState((prev) => {
          const s = prev.sessions[sessionId];
          if (!s) return prev;
          return {
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...s, messageTree: newTree, execLeafId: newLeaf, viewLeafId: newLeaf },
            },
          };
        });
        if (!newLeaf) {
          log('warn', `[Resume] ⏭ 跳过会话 ${sessionId}：恢复点回退到根节点`);
          return;
        }
        finalResumeFrom = newLeaf;
      }
    }
  } else {
    // 无法合成（sourceCommit=false 或无 batch_commit/clear_batch_cache toolCall）
    // 使用原始 messageTree（无合成消息）
    const currentSession = useChatStore.getState().sessions[sessionId];
    if (!currentSession) return;
    const newTree = removeSubtree(currentSession.messageTree, lastAssistant.id);
    const newLeaf = lastAssistant.parentId;
    log('log', `[Resume]   ✂ 清理不完整轮次 ${lastAssistant.id.slice(-8)}，回退到 ${newLeaf || '(root)'}`);

    useChatStore.setState((prev) => {
      const s = prev.sessions[sessionId];
      if (!s) return prev;
      return {
        sessions: {
          ...prev.sessions,
          [sessionId]: { ...s, messageTree: newTree, execLeafId: newLeaf, viewLeafId: newLeaf },
        },
      };
    });

    if (!newLeaf) {
      log('warn', `[Resume] ⏭ 跳过会话 ${sessionId}：恢复点回退到根节点，无有效上下文`);
      return;
    }
    finalResumeFrom = newLeaf;
  }

  // 设置恢复点
  useChatStore.setState((prev) => {
    const s = prev.sessions[sessionId];
    if (!s) return prev;
    return {
      sessions: {
        ...prev.sessions,
        [sessionId]: { ...s, execLeafId: finalResumeFrom, viewLeafId: finalResumeFrom },
      },
    };
  });

  log('log', `[Resume] ▶ 恢复会话 ${sessionId}（从 ${finalResumeFrom.slice(-8)} 继续）`);
  await doStream(sessionId);
}

// ═══════════════════════════════════════════════════════════
//  checkStalledSessions（路径②入口）
// ═══════════════════════════════════════════════════════════

/**
 * 检查快照中的会话在提交后是否被意外终止。
 *
 * 由 batch_commit 工具执行函数在 finalizeCommit 返回后调用。
 * 使用统一的 assessSessionForRecovery + executeRecovery。
 * 多个会话并发恢复（不 await，fire-and-forget）。
 */
export function checkStalledSessions(snapshot: SessionSnapshot[]): void {
  recoveryLog('log', '[Resume] ── 提交后会话健康检查 ──');

  for (const entry of snapshot) {
    const session = useChatStore.getState().sessions[entry.sessionId];
    const label = `"${session?.title || '(无标题)'}" (${entry.sessionId})`;

    const verdict = assessSessionForRecovery(session, entry);

    if (verdict.action === 'skip') {
      const reasonMap: Record<string, string> = {
        'session-not-found': `⏭ 不存在: ${label}`,
        'already-running': `✓ 仍在运行: ${label}`,
        'naturally-ended': `✓ 已停止（有新气泡，自然/错误结束）: ${label}`,
        'no-resume-point': `⏭ 无恢复点: ${label}`,
      };
      recoveryLog(
        verdict.reason === 'session-not-found' || verdict.reason === 'no-resume-point'
          ? 'warn'
          : 'log',
        `[Resume]   ${reasonMap[verdict.reason] || verdict.reason}`,
      );
      continue;
    }

    recoveryLog(
      'warn',
      `[Resume]   ⚠ 已停止（消息未变→被杀）: ${label} lastId=${entry.lastMessageId?.slice(-8)}→${session?.execLeafId?.slice(-8)}`,
    );

    // 终止旧 AbortController，防止 HMR 后残留的 doStream 和新恢复的并发写入
    session?.abortController?.abort();

    // 并发恢复，不 await
    const doStream = getRecoveryExecutor();
    executeRecovery(verdict, doStream, recoveryLog).catch(() => {});
  }
}