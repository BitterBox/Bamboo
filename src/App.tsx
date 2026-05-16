import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import DataLoader from './components/DataLoader';
import SetupGate from './components/SetupGate';
import Layout from './components/Layout';
import { useChatStore, flushSessionUpdates } from './store/chatStore';
import { useSettingsStore } from './store/settingsStore';
import { useAutoCommitNotify } from './hooks/useAutoCommitNotify';
import { useSessionRecovery } from './hooks/useSessionRecovery';

function App() {
  // 挂载自动提交超时通知监听（在主进程自动 batch_commit 前插入提示消息）
  useAutoCommitNotify();

  // Vite 刷新后自动恢复被中断的会话
  useSessionRecovery();

  // 页面刷新/关闭前强制同步保存到 sessionStorage
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        const state = useChatStore.getState();
        // ═══ 先 flush 所有会话的 pending chunks！ ═══
        for (const sessionId of Object.keys(state.sessions)) {
          flushSessionUpdates(sessionId);
        }
        // 重新获取 flush 后的最新状态
        const latestState = useChatStore.getState();
        const { sessions, sessionOrder, currentSessionId } = latestState;
        const cleanedSessions: Record<string, any> = {};
        for (const [id, session] of Object.entries(sessions)) {
          cleanedSessions[id] = {
            id: session.id,
            title: session.title,
            isStarred: !!session.isStarred,
            thinkingMode: session.thinkingMode || 'auto',
            draft: session.draft || '',
            rootMessageId: session.rootMessageId,
            execLeafId: session.execLeafId,
            viewLeafId: session.viewLeafId,
            messageTree: Object.fromEntries(
              Object.entries(session.messageTree)
                .map(([msgId, m]) => [msgId, {
                  id: m.id,
                  parentId: m.parentId,
                  role: m.role,
                  content: m.content,
                  timestamp: m.timestamp,
                  ...(m.tokenUsage ? { tokenUsage: m.tokenUsage } : {}),
                  ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                  ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
                  ...(m.toolResult ? { toolResult: m.toolResult } : {}),
                  ...(m.model ? { model: m.model } : {}),
                  ...(m.providerName ? { providerName: m.providerName } : {}),
                }]),
            ),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            agentId: session.agentId,
            llmConfig: session.llmConfig,
            mcpConfig: session.mcpConfig,
          };
        }
        const data = {
          version: 3,
          sessions: cleanedSessions,
          sessionOrder,
          currentSessionId,
        };
        sessionStorage.setItem('chat-history-session', JSON.stringify(data));
      } catch (e) {
        // beforeunload 中不可 throw 异常，静默处理
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      useChatStore.getState().cleanup();
    };
  }, []);

  // Ctrl+滚轮调整字号（设置-外观中的字号）
  useEffect(() => {
    let rafId: number | null = null;
    let pendingDelta = 0;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      pendingDelta += Math.sign(-e.deltaY); // 每格滚轮 ±1px

      if (rafId !== null) return; // 已有待处理的帧，跳过
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const delta = pendingDelta;
        pendingDelta = 0;
        const { appConfig, updateAppConfig } = useSettingsStore.getState();
        const newSize = Math.max(10, Math.min(22, appConfig.fontSize + delta));
        updateAppConfig({ fontSize: Math.round(newSize) });
      });
    };

    window.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      window.removeEventListener('wheel', handleWheel);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <DataLoader>
      <SetupGate>
        <BrowserRouter>
          <Layout />
        </BrowserRouter>
      </SetupGate>
    </DataLoader>
  );
}

export default App;
