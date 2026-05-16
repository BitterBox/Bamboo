// ============================================================
// useSessionRecovery — Vite 刷新后自动恢复被中断的会话
//
// 职责：
//   1. 注册 streamNewResponse 为恢复执行器（供 checkStalledSessions 使用）
//   2. 启动时 IPC 查询主进程恢复清单 → assessSessionForRecovery → executeRecovery
//
// 替代旧的 useResumePausedSessions。
// ============================================================

import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import { useChat } from './useChat';
import {
  setRecoveryExecutor,
  assessSessionForRecovery,
  executeRecovery,
  recoveryLog,
} from './sessionRecovery';

export function useSessionRecovery() {
  const hasRun = useRef(false);
  const { streamNewResponse } = useChat();
  const streamRef = useRef(streamNewResponse);
  streamRef.current = streamNewResponse;

  // ── 恢复检查核心逻辑（提取为独立函数，供首次挂载和 store 重建事件共用）──
  const doCheck = async () => {
    if (!window.electronAPI?.checkRecoveryList) return;

    recoveryLog('log', '[Resume] ────── 检查恢复清单 ──────');

    try {
      const result = await window.electronAPI.checkRecoveryList();
      const sessions = result?.sessions;

      if (!sessions || sessions.length === 0) {
        recoveryLog('log', '[Resume] 恢复清单为空，正常启动');
        return;
      }

      recoveryLog('log', `[Resume] 检测到 ${sessions.length} 个会话需要恢复:`);
      sessions.forEach((e: any, i: number) => {
        recoveryLog(
          'log',
          `[Resume]   ${i + 1}. session=${e.sessionId} leaf=${e.execLeafId?.slice(-8)} source=${e.sourceCommit || false}`,
        );
      });

      let resumed = 0;
      let skipped = 0;

      for (const entry of sessions) {
        try {
          const session = useChatStore.getState().sessions[entry.sessionId];
          const verdict = assessSessionForRecovery(session, entry);

          if (verdict.action === 'skip') {
            recoveryLog('warn', `[Resume] ⏭ 跳过会话 ${entry.sessionId}：${verdict.reason}`);
            skipped++;
            continue;
          }

          // 串行恢复：等一个会话恢复完再处理下一个
          const streamPromise = executeRecovery(
            verdict,
            (sid) => streamRef.current(sid),
            recoveryLog,
          );

            // 等一个 tick，让 streamNewResponse 内的同步 guard 有机会执行
            await new Promise((resolve) => setTimeout(resolve, 100));

            const sessionAfter = useChatStore.getState().sessions[entry.sessionId];
            if (sessionAfter?.isStreaming || sessionAfter?.isAgentRunning) {
              recoveryLog(
                'log',
                `[Resume]   ✅ 流式已启动 (isStreaming=${sessionAfter.isStreaming}, isAgentRunning=${sessionAfter.isAgentRunning})`,
              );
            } else {
              recoveryLog(
                'warn',
                `[Resume]   ⚠️ 流式未启动 (isStreaming=${sessionAfter?.isStreaming ?? 'undefined'}, isAgentRunning=${sessionAfter?.isAgentRunning ?? 'undefined'})`,
              );
            }

            // 消费可能发生的异步 rejection
            await streamPromise.catch(() => {});

            resumed++;
          } catch (err) {
            recoveryLog(
              'error',
              `[Resume] ✗ 恢复会话 ${entry.sessionId} 失败: ${(err as Error)?.message || err}`,
            );
            skipped++;
          }
        }

        recoveryLog('log', `[Resume] ────── 恢复完成: ${resumed} 个成功, ${skipped} 个跳过 ──────`);
      } catch (err) {
        recoveryLog('error', `[Resume] 获取恢复清单失败: ${(err as Error)?.message || err}`);
      }
    };

  // ── 首次挂载：注册恢复执行器 + 检查恢复清单（full-reload 场景）──
  useEffect(() => {
    setRecoveryExecutor((sessionId: string) => streamRef.current(sessionId));

    if (hasRun.current) return;
    hasRun.current = true;

    // 等待 DataLoader 完成加载
    if (useChatStore.getState().isLoaded) {
      doCheck();
    } else {
      const unsub = useChatStore.subscribe((state) => {
        if (state.isLoaded) {
          unsub();
          doCheck();
        }
      });
      // 安全阀：10 秒后无论如何执行
      const safetyTimer = setTimeout(() => {
        unsub();
        doCheck();
      }, 10_000);
      return () => {
        unsub();
        clearTimeout(safetyTimer);
      };
    }
  }, []);

  // ── store 重建事件监听（partial HMR 场景：chatStore 模块被 HMR 重新执行时触发）──
  useEffect(() => {
    const handler = () => {
      recoveryLog('log', '[Resume] 检测到 store 重建，检查恢复清单...');
      doCheck();
    };
    window.addEventListener('store-recreated', handler);
    return () => window.removeEventListener('store-recreated', handler);
  }, []);
}