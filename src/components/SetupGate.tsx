// ============================================================
// SetupGate — 数据路径配置门禁
// 首次启动或未配置数据路径时，强制用户选择存储目录后才能使用应用
//
// 职责：
//   - 检测 needsDataPathSetup 标志
//   - 为 true 时显示全屏设置引导页面，阻塞所有其他路由
//   - 用户选择目录并保存后，自动放行
// ============================================================

import { useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';

export default function SetupGate({ children }: { children: React.ReactNode }) {
  const needsDataPathSetup = useSettingsStore((s) => s.needsDataPathSetup);
  const isLoaded = useSettingsStore((s) => s.isLoaded);
  const appConfig = useSettingsStore((s) => s.appConfig);
  const updateAppConfig = useSettingsStore((s) => s.updateAppConfig);
  const saveAppConfig = useSettingsStore((s) => s.saveAppConfig);

  const [isSelecting, setIsSelecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 数据尚未加载完成，等待
  if (!isLoaded) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: 16,
        color: '#888',
      }}>
        加载中…
      </div>
    );
  }

  // 已配置数据路径，放行
  if (!needsDataPathSetup) {
    return <>{children}</>;
  }

  // ── 未配置数据路径：显示设置引导 ────────────────────────

  const handleSelectFolder = async () => {
    if (!window.electronAPI) return;
    setIsSelecting(true);
    setErrorMsg(null);
    try {
      const selectedPath = await window.electronAPI.selectFolder();
      if (selectedPath) {
        updateAppConfig({ dataPath: selectedPath });
        await saveAppConfig();
        // 全量刷新让 DataLoader 从新路径重新加载所有数据
        window.location.reload();
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '选择目录失败');
    } finally {
      setIsSelecting(false);
    }
  };

  const handleManualPath = async () => {
    const path = appConfig.dataPath; // 已由 onChange 实时同步
    if (!path) {
      setErrorMsg('请输入一个有效的目录路径');
      return;
    }
    try {
      setErrorMsg(null);
      await saveAppConfig();
      // 全量刷新让 DataLoader 从新路径重新加载所有数据
      window.location.reload();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '配置保存失败');
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      background: '#1a1a2e',
      color: '#e0e0e0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      gap: 24,
      padding: 32,
    }}>
      {/* Logo / 标题 */}
      <div style={{ fontSize: 48, marginBottom: 8 }}>💬</div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: '#fff' }}>
        LLM Chat Demo
      </h1>
      <p style={{ fontSize: 14, color: '#999', margin: 0, textAlign: 'center', maxWidth: 420 }}>
        欢迎使用。在开始之前，请选择一个本地目录用于存储对话记录和应用数据。
      </p>

      <div style={{
        background: '#16213e',
        borderRadius: 12,
        padding: 28,
        width: '100%',
        maxWidth: 460,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        {/* 路径输入 + 浏览按钮 */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={appConfig.dataPath}
            onChange={(e) => updateAppConfig({ dataPath: e.target.value })}
            placeholder="例如：D:\my-chat-data"
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #333',
              background: '#0f0f23',
              color: '#e0e0e0',
              fontSize: 14,
              outline: 'none',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleManualPath(); }}
          />
          <button
            onClick={handleSelectFolder}
            disabled={isSelecting}
            style={{
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid #444',
              background: '#2a2a4a',
              color: '#e0e0e0',
              cursor: isSelecting ? 'not-allowed' : 'pointer',
              fontSize: 13,
              whiteSpace: 'nowrap',
              opacity: isSelecting ? 0.6 : 1,
            }}
          >
            {isSelecting ? '…' : '浏览…'}
          </button>
        </div>

        {/* 提示信息 */}
        <div style={{
          fontSize: 12,
          color: '#888',
          lineHeight: 1.6,
          background: '#0f0f23',
          borderRadius: 8,
          padding: '10px 14px',
        }}>
          <p style={{ margin: 0 }}>
            📁 所有对话记录、设置和备份文件都将存放在此目录中。
          </p>
          <p style={{ margin: '4px 0 0 0' }}>
            🔒 数据完全存储在你自己的设备上，不会上传到任何服务器。
          </p>
        </div>

        {/* 错误提示 */}
        {errorMsg && (
          <div style={{
            fontSize: 13,
            color: '#ff6b6b',
            background: 'rgba(255,107,107,0.1)',
            borderRadius: 8,
            padding: '8px 14px',
          }}>
            {errorMsg}
          </div>
        )}

        {/* 确认按钮 */}
        <button
          onClick={handleManualPath}
          style={{
            width: '100%',
            padding: '12px 0',
            borderRadius: 8,
            border: 'none',
            background: '#4a6cf7',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          确认并开始使用
        </button>
      </div>
    </div>
  );
}