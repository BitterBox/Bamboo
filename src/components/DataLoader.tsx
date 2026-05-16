// ============================================================
// DataLoader — 应用数据初始化组件
// 在根组件挂载后并发加载设置和聊天历史，加载完成前显示占位 Loading
//
// 职责：
//   - 阻塞子树渲染，直到持久化数据就绪，防止使用默认值覆盖已有数据
//   - 并发请求 loadSettings + loadChatHistory，最小化冷启动时间
//
// 扩展指南：
//   - 多数据源：在 loadData 中追加更多 Promise（如用户信息、插件配置）
//   - 错误边界：在加载失败时显示重试按钮，而非无限 Loading
//   - 骨架屏：将 "加载中..." 替换为与 Chat 布局一致的骨架组件
// ============================================================

import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import { mcpRegistry } from '../services/mcp';
import { loadAllTools } from '../services/mcp/manifestLoader';
// 导入工具模块以触发 registerBuiltinExecutor() 调用
import '../services/mcp/fileTools';
import '../services/mcp/codeTools';
import '../services/mcp/pythonTools';
import '../services/mcp/webTools';

export default function DataLoader({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 只订阅 load 方法，不订阅整个 store，避免加载后的状态变化触发重渲染
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const loadChatHistory = useChatStore((state) => state.loadChatHistory);

  useEffect(() => {
    const loadData = async () => {
      try {
        // 并发加载设置和聊天历史，总耗时 = max(设置加载时间, 聊天历史加载时间)
        // 即使路径未配置，也要加载聊天历史——读取失败只是空数据，不会 crash
        await Promise.all([
          loadSettings(),
          loadChatHistory().catch((err) => {
            console.error('Failed to load chat history:', err);
          }),
        ]);
        // 注册 MCP 工具（从 /tools/builtin/*.json 清单加载定义，执行器由各工具模块注册）
        await loadAllTools(mcpRegistry);
      } catch (err) {
        console.error('Failed to load data:', err);
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [loadSettings, loadChatHistory]);

  if (error) {
    // 加载失败时显示错误提示和重试按钮
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: '16px',
        color: '#666',
        gap: '16px',
      }}>
        <div style={{ color: '#d32f2f' }}>加载失败: {error}</div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            cursor: 'pointer',
            border: '1px solid #ccc',
            borderRadius: '4px',
            background: '#fff',
          }}
        >
          重新加载
        </button>
      </div>
    );
  }

  if (isLoading) {
    // 全屏居中 Loading 占位（待实现：骨架屏）
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: '18px',
        color: '#666',
      }}>
        加载中...
      </div>
    );
  }

  // 数据就绪后透传渲染子树
  return <>{children}</>;
}
