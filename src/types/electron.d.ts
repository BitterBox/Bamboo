// Electron API 类型定义
export interface ElectronAPI {
  // ═══════════════════════════════════════════════════════════
  // 统一工具执行通道
  // ═══════════════════════════════════════════════════════════
  toolExecute: (toolName: string, args: Record<string, unknown>, sessionId?: string | null) => Promise<any>;

  // ── 基础 API ──
  readSettings: () => Promise<any>;
  writeSettings: (data: any) => Promise<void>;
  readChatHistory: () => Promise<any>;
  writeChatHistory: (data: any) => Promise<void>;
  getDataPath: () => Promise<string>;
  readAppConfig: () => Promise<any>;
  writeAppConfig: (data: any) => Promise<void>;
  selectFolder: () => Promise<string | null>;
  needsDataPathSetup: () => Promise<boolean>;

  // ── 批量事务基础设施 ──
  mcpFinalizeCommit: (commitId: string, sessionsSnapshot: any[]) => Promise<{ error: string | null; message?: string; results?: any[]; commitDir?: string }>;
  mcpClearRecoveryList: (commitId: string) => Promise<{ success: boolean }>;

  // ── 目录写锁 ──
  mcpGetDirLockState: () => Promise<Array<{ dir: string; holder: string }>>;
  mcpAcquireDirLocks: (sessionId: string, filePaths: string[], allowedDirs: string[]) => Promise<{ status: 'acquired' | 'blocked'; acquired: string[]; blocked: Array<{ filePath: string; dir: string; holder: string }> }>;
  mcpWaitForDirLocks: (sessionId: string, blocked: Array<{ filePath?: string; dir: string; holder?: string }>) => Promise<{ status: 'acquired' }>;
  mcpReleaseDirLocks: (sessionId: string) => Promise<{ released: string[] }>;
  mcpWaitDirLockRelease: (dirPath: string, sessionId: string) => Promise<{ status: string }>;
  mcpCancelWaitForLocks: (sessionId: string) => Promise<{ status: string }>;
  mcpNotifySessionClosed: (sessionId: string) => Promise<{ released: string[] }>;

  // ── Conda 环境扫描（UI 用）──
  mcpListCondaEnvs: () => Promise<{ error?: string; envs: string[] }>;

  // ── 用户工具清单 ──
  listUserToolManifests: () => Promise<{ error: string | null; manifests: any[] }>;

  // ── 恢复清单 ──
  checkRecoveryList: () => Promise<{ sessions: any[] | null }>;

  // ── 自动提交通知 ──
  onAutoCommitNotify: (callback: (sessionId: string) => void) => () => void;
  onAutoCommitPrepared: (callback: (data: any) => void) => () => void;
  autoCommitNotifyDone: (sessionId: string, sessionsSnapshot: any[]) => Promise<{ success: boolean }>;

  // ── 日志转发 ──
  logToMain: (level: string, message: string) => void;

  // ── 格物 ──
  onGeWu: (callback: (text: string) => void) => () => void;

  // ── 文件管理 ──
  fileSave: (meta: { originalName: string; contentBase64: string; mimeType: string; sessionId: string; sessionTitle: string; messageId: string; hash?: string }) => Promise<{ error: string | null; filePath?: string; existed?: boolean }>;
  fileList: () => Promise<{ files: Array<{ filePath: string; originalName: string; size: number; mimeType: string; sessionId: string; sessionTitle: string; messageId: string; importedAt: number }>; error: string | null }>;
  fileDelete: (filePath: string) => Promise<{ error: string | null }>;
  fileRead: (filePath: string) => Promise<{ content: string | null; error: string | null; encoding?: 'utf-8' | 'base64' }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
