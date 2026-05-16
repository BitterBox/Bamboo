// ============================================================
// useAutoCommitNotify — 自动提交超时通知 Hook
//
// 职责：
//   监听主进程的 auto-commit-notify IPC 事件，在收到通知后：
//   1. 等待当前一轮输出结束（委托给 chatStore.onRoundEnd）
//   2. 插入一则 user 消息提醒用户
//   3. 通知主进程确认完成，继续执行自动提交
//
// 设计原则：只等当前一轮，不等到整个 Agentic Loop 结束。
//   例如：用户消息 → 思考1 → 输出1 → toolCall1 → toolResult1 ← 这里就可以插入
//         → 思考2 → 输出2 → toolCall2 → ...              （不等后面继续）
// ============================================================

import { useEffect, useRef } from 'react';
import { useChatStore, flushSessionUpdates, onRoundEnd } from '../store/chatStore';

/**
 * 等待当前一轮输出结束，委托给 chatStore.onRoundEnd。
 * 完成后 flush 残留缓冲区，确保通知消息写入前状态一致。
 */
function waitForCurrentRoundEnd(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    onRoundEnd(sessionId, () => {
      const s = useChatStore.getState().sessions[sessionId];
      if (s) flushSessionUpdates(sessionId);
      resolve();
    });
  });
}

/**
 * Hook：监听主进程自动提交超时通知
 *
 * 在 App 根组件中挂载一次即可，无需在子组件重复调用。
 * 浏览器（非 Electron）环境下静默无操作。
 */
export function useAutoCommitNotify() {
  // 使用 ref 存储正在处理的 sessionId，防止并发多个通知时冲突
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 仅在 Electron 环境下生效
    if (!window.electronAPI?.onAutoCommitNotify) return;

    const unsubscribe = window.electronAPI.onAutoCommitNotify(
      async (sessionId: string) => {
        // 用微任务解耦，让 message handler 立即返回
        await new Promise(r => setTimeout(r, 0));

        if (processingRef.current.has(sessionId)) {
          console.warn(`[autoCommitNotify] session ${sessionId} 已有一个正在处理的通知，跳过重复`);
          await window.electronAPI!.autoCommitNotifyDone(sessionId, []);
          return;
        }

        processingRef.current.add(sessionId);

        try {
          // 1. 等待当前一轮输出完毕（事件驱动，零轮询）
          await waitForCurrentRoundEnd(sessionId);

          // 2. 再次检查 session 是否存在
          const state = useChatStore.getState();
          const session = state.sessions[sessionId];
          if (!session) {
            await window.electronAPI!.autoCommitNotifyDone(sessionId, []);
            return;
          }

          // 3. 插入 user 提示消息
          const now = new Date();
          const timeStr = now.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });

          useChatStore.getState().addMessage(sessionId, {
            role: 'user',
            content: `⏰ **自动提交通知**（${timeStr}）\n\n检测到暂存修改长时间未提交，系统已自动执行 batch_commit 将修改写入磁盘。\n\n如需查看提交记录，可使用 \`list_recent_commits\` 工具查看最近提交的快照。`,
          });

          // ═══ 4. flush + save + 收集会话快照 ═══
          const { flushAndSave, collectSessionSnapshot } = await import('./sessionRecovery');
          await flushAndSave();
          const sessionsSnapshot = collectSessionSnapshot(sessionId);

          // 5. 通知主进程：确认完成 + 会话快照
          await window.electronAPI!.autoCommitNotifyDone(sessionId, sessionsSnapshot);
        } catch (err) {
          console.error('[autoCommitNotify] 处理通知时出错:', err);
          try { await window.electronAPI!.autoCommitNotifyDone(sessionId, []); } catch { }
        } finally {
          processingRef.current.delete(sessionId);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);
}
