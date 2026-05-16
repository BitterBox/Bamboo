const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ═══════════════════════════════════════════════════════════
  // 统一工具执行通道（新）
  // 所有 MCP 工具调用通过此单一入口，替代下方 mcp* 方法
  // ═══════════════════════════════════════════════════════════
  toolExecute: (toolName, args, sessionId) => ipcRenderer.invoke('tool-execute', toolName, args, sessionId),

  // ── 以下为旧版独立通道（保留向后兼容，逐步迁移后移除）──
  readSettings: () => ipcRenderer.invoke('read-settings'),
  writeSettings: (data) => ipcRenderer.invoke('write-settings', data),
  readChatHistory: () => ipcRenderer.invoke('read-chat-history'),
  writeChatHistory: (data) => ipcRenderer.invoke('write-chat-history', data),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  readAppConfig: () => ipcRenderer.invoke('read-app-config'),
  writeAppConfig: (data) => ipcRenderer.invoke('write-app-config', data),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  needsDataPathSetup: () => ipcRenderer.invoke('needs-data-path-setup'),
  // 批量事务基础设施
  mcpFinalizeCommit: (commitId, sessionsSnapshot) => ipcRenderer.invoke('mcp-finalize-commit', commitId, sessionsSnapshot),
  mcpClearRecoveryList: (commitId) => ipcRenderer.invoke('mcp-clear-recovery-list', commitId),
  // 目录写锁 IPC
  mcpGetDirLockState: () => ipcRenderer.invoke('mcp-get-dir-lock-state'),
  mcpAcquireDirLocks: (sessionId, filePaths, allowedDirs) => ipcRenderer.invoke('mcp-acquire-dir-locks', sessionId, filePaths, allowedDirs),
  mcpWaitForDirLocks: (sessionId, blocked) => ipcRenderer.invoke('mcp-wait-for-dir-locks', sessionId, blocked),
  mcpReleaseDirLocks: (sessionId) => ipcRenderer.invoke('mcp-release-dir-locks', sessionId),
  mcpWaitDirLockRelease: (dirPath, sessionId) => ipcRenderer.invoke('mcp-wait-dir-lock-release', dirPath, sessionId),
  mcpCancelWaitForLocks: (sessionId) => ipcRenderer.invoke('mcp-cancel-wait-for-locks', sessionId),
  mcpNotifySessionClosed: (sessionId) => ipcRenderer.invoke('mcp-notify-session-closed', sessionId),
  // Conda 环境扫描（UI 用，非工具调用）
  mcpListCondaEnvs: () => ipcRenderer.invoke('mcp-list-conda-envs'),
  // 恢复清单
  checkRecoveryList: () => ipcRenderer.invoke('check-recovery-list'),
  // 自动提交通知
  onAutoCommitNotify: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('auto-commit-notify', handler);
    return () => ipcRenderer.removeListener('auto-commit-notify', handler);
  },
  onAutoCommitPrepared: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('auto-commit-prepared', handler);
    return () => ipcRenderer.removeListener('auto-commit-prepared', handler);
  },
  autoCommitNotifyDone: (sessionId, sessionsSnapshot) => ipcRenderer.invoke('mcp-auto-commit-notify-done', sessionId, sessionsSnapshot),
  // 日志转发
  logToMain: (level, message) => ipcRenderer.send('log-to-main', level, message),
  // 格物
  onGeWu: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on('ge-wu', handler);
    return () => ipcRenderer.removeListener('ge-wu', handler);
  },
  // 文件管理
  fileSave: (meta) => ipcRenderer.invoke('file-save', meta),
  fileList: () => ipcRenderer.invoke('file-list'),
  fileDelete: (filePath) => ipcRenderer.invoke('file-delete', filePath),
  fileRead: (filePath) => ipcRenderer.invoke('file-read', filePath),
  // 用户工具清单
  listUserToolManifests: () => ipcRenderer.invoke('list-user-tool-manifests'),
});
