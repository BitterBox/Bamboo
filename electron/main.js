const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const codeTools = require('./codeTools');
const lockManager = require('./lockManager');
const batchManager = require('./batchManager');
const pythonSandbox = require('./pythonSandbox');
const toolExecutor = require('./toolExecutor');

// 加载应用图标（从 PNG 文件）
function loadAppIcon() {
  try {
    const pngPath = path.join(__dirname, '../public/vite.png');
    return nativeImage.createFromPath(pngPath);
  } catch (e) {
    return undefined;
  }
}

// 在 Windows 上自动切换控制台编码为 UTF-8，解决中文乱码问题
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) {
    // 忽略编码切换失败的情况
  }
}

let mainWindow;

// 应用配置文件（存储在 userData 目录，仅保存 dataPath 用于引导）
const APP_CONFIG_DIR = path.join(app.getPath('userData'), 'config');
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'app-config.json');

// 当前数据目录（运行时动态设置，无默认值——必须由用户显式配置）
let currentDataDir = '';
let SETTINGS_FILE;
let CHAT_FILE;              // 保留：迁移读取旧格式
let SESSIONS_DIR;            // 新增：sessions/ 目录（v4 拆分格式）
let CHAT_INDEX_FILE;         // 新增：chat-index.json（轻量索引）
let FILE_DIR;                // 新增：file/ 目录（导入文件存储）
let FILE_MANIFEST;           // 新增：file/file-manifest.json（文件索引）

// 更新数据文件路径
function updateDataPaths() {
  SETTINGS_FILE = path.join(currentDataDir, 'settings.json');
  CHAT_FILE = path.join(currentDataDir, 'chat-history.json');
  SESSIONS_DIR = path.join(currentDataDir, 'sessions');
  CHAT_INDEX_FILE = path.join(currentDataDir, 'chat-index.json');
  FILE_DIR = path.join(currentDataDir, 'file');
  FILE_MANIFEST = path.join(FILE_DIR, 'file-manifest.json');
}

// 确保目录存在
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    console.error('Failed to create directory:', error);
  }
}

// 读取应用配置
async function loadAppConfig() {
  try {
    await ensureDir(APP_CONFIG_DIR);
    const data = await fs.readFile(APP_CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data);
    if (config.dataPath) {
      currentDataDir = config.dataPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load app config:', error);
    }
    // 使用默认路径
  }
  updateDataPaths();
  await ensureDir(currentDataDir);
}

// 保存应用配置（仅 dataPath，其余设置存储在 dataDir/settings.json 中）
async function saveAppConfig(config) {
  await ensureDir(APP_CONFIG_DIR);
  await fs.writeFile(APP_CONFIG_FILE, JSON.stringify({ dataPath: config.dataPath || '' }, null, 2), 'utf-8');
}

// 读取文件
async function readFile(filePath, defaultValue = null) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 文件不存在，返回默认值
      return defaultValue;
    }
    if (error instanceof SyntaxError) {
      // JSON 解析错误，返回默认值并记录错误
      console.error(`Failed to parse JSON from ${filePath}:`, error);
      return defaultValue;
    }
    throw error;
  }
}

// 写入文件
async function writeFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// 检查文件是否存在
async function fileExists(filePath) {
  try { await fs.stat(filePath); return true; } catch { return false; }
}

// ── v4 拆分格式：从 sessions/ 目录读取所有会话 ──────────
async function readSessionsFromNewFormat() {
  const index = await readFile(CHAT_INDEX_FILE, { sessionOrder: [], currentSessionId: null });

  const sessions = {};
  const files = await fs.readdir(SESSIONS_DIR).catch(() => []);
  const results = await Promise.all(
    files
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(async (f) => {
        const session = await readFile(path.join(SESSIONS_DIR, f), null);
        if (session && session.id) return [session.id, session];
        return null;
      })
  );

  for (const entry of results) {
    if (entry) sessions[entry[0]] = entry[1];
  }

  // 从磁盘已有会话重建 sessionOrder（列表末尾追加，保持已有顺序优先）
  const diskIds = results.filter(Boolean).map(([id]) => id);

  // 清理索引中有但磁盘上不存在的会话
  let validOrder = index.sessionOrder.filter(id => sessions[id]);

  // 将磁盘上有但索引里没有的会话追加到末尾（按文件修改时间排序）
  const missingFromIndex = diskIds.filter(id => !index.sessionOrder.includes(id));
  if (missingFromIndex.length > 0) {
    // 按 mtime 排序，越新越靠后（追加到末尾）
    const sorted = await sortFilesByMtime(
      missingFromIndex.map(id => path.join(SESSIONS_DIR, `${id}.json`)),
      files,
      SESSIONS_DIR,
    );
    validOrder = [...validOrder, ...sorted];
  }

  // 极端兜底：索引完全为空但磁盘有会话 → 全部用 mtime 排序
  if (validOrder.length === 0 && diskIds.length > 0) {
    validOrder = await sortFilesByMtime(
      diskIds.map(id => path.join(SESSIONS_DIR, `${id}.json`)),
      files,
      SESSIONS_DIR,
    );
  }

  const validCurrent = sessions[index.currentSessionId] ? index.currentSessionId : (validOrder[0] || null);

  return { sessions, sessionOrder: validOrder, currentSessionId: validCurrent, version: 4 };
}

/**
 * 按文件修改时间排序，返回排序后的 session id 列表（越新越靠后）
 * @param fullPaths 完整文件路径列表
 * @param allFiles 从 fs.readdir 得到的文件名列表（用于加速匹配，可选）
 * @param baseDir 基础目录（可选，与 allFiles 配合使用）
 */
async function sortFilesByMtime(fullPaths, allFiles = [], baseDir = '') {
  const stats = await Promise.all(
    fullPaths.map(async (fp) => {
      try {
        const stat = await fs.stat(fp);
        return { path: fp, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  const fileMap = new Map(allFiles.map(f => [path.join(baseDir, f), f]));

  return stats
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime)
    .map(s => {
      // 从完整路径推断 session id: .../sessions/{id}.json
      const name = fileMap.get(s.path) || path.basename(s.path);
      return name.replace(/\.json$/i, '');
    });
}

// ── v4 拆分格式：将全量数据写入 sessions/ + chat-index.json ──
async function writeSessionsToNewFormat(sessions, sessionOrder, currentSessionId) {
  await ensureDir(SESSIONS_DIR);

  // 写入所有会话文件
  await Promise.all(
    Object.entries(sessions).map(async ([sid, session]) => {
      const filePath = path.join(SESSIONS_DIR, `${sid}.json`);
      await writeFile(filePath, session);
    })
  );

  // 删除磁盘上多余的会话文件（会话已删除但文件还在）
  const validIds = new Set(Object.keys(sessions));
  const existingFiles = await fs.readdir(SESSIONS_DIR).catch(() => []);
  await Promise.all(
    existingFiles
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && !validIds.has(f.replace('.json', '')))
      .map(f => fs.unlink(path.join(SESSIONS_DIR, f)).catch(() => {}))
  );

  // 写入轻量索引（<1KB，不含会话内容）
  await writeFile(CHAT_INDEX_FILE, { sessionOrder, currentSessionId });
}

// ═══════════════════════════════════════════════
// 批量写入事务系统（HMR-safe batch write）
// 每个 session 独立维护批量状态，防止多角色/多会话并发互相污染
// ═══════════════════════════════════════════════

// 目录级写锁 → lockManager.js  批量写入事务 → batchManager.js
// 初始化在 createWindow 后调用: batchManager.init(currentDataDir, mainWindow)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ── 原生右键上下文菜单 ──────────────────────────────────
  // 为整个窗口提供复制/粘贴/全选等基础编辑操作
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { selectionText, isEditable, editFlags } = params;
    const template = [];

    // ── 文本选区操作 ──
    if (selectionText && selectionText.trim().length > 0) {
      template.push({
        label: '复制',
        accelerator: 'CmdOrCtrl+C',
        role: 'copy',
        enabled: editFlags.canCopy,
      });
      template.push({
        label: '剪切',
        accelerator: 'CmdOrCtrl+X',
        role: 'cut',
        enabled: isEditable && editFlags.canCut,
      });

      // 选中文本时，添加"格物"：发送给 LLM 询问"是什么"
      template.push({ type: 'separator' });
      template.push({
        label: `格物`,
        click: () => {
          mainWindow.webContents.send('ge-wu', selectionText.trim());
        },
      });
    }

    // ── 输入框操作 ──
    if (isEditable) {
      template.push({
        label: '粘贴',
        accelerator: 'CmdOrCtrl+V',
        role: 'paste',
        enabled: editFlags.canPaste,
      });

      if (template.length > 0) {
        template.push({ type: 'separator' });
      }

      template.push({
        label: '全选',
        accelerator: 'CmdOrCtrl+A',
        role: 'selectAll',
      });
    }

    // 如果没有任何可用的菜单项，显示一个最低限度的菜单
    if (template.length === 0) {
      template.push({
        label: '全选',
        accelerator: 'CmdOrCtrl+A',
        role: 'selectAll',
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // 开发模式加载 Vite 服务器
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  await loadAppConfig();
  createWindow();
  batchManager.init(currentDataDir, mainWindow);
  await batchManager.cleanupStalePending();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC 处理器

// 读取应用配置
ipcMain.handle('read-app-config', async () => {
  return await readFile(APP_CONFIG_FILE, null);
});

// 写入应用配置（仅 dataPath）并更新数据路径
ipcMain.handle('write-app-config', async (event, config) => {
  await saveAppConfig(config);
  if (config.dataPath) {
    currentDataDir = config.dataPath;
    updateDataPaths();
    await ensureDir(currentDataDir);
    batchManager.updateDataDir(currentDataDir);
  }
});

// 选择文件夹对话框
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择数据存储目录',
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 检查是否需要用户配置数据路径
// 条件：默认路径下不存在会话数据（sessions/ 或 chat-index.json），
// 且 APP_CONFIG_FILE 也未写入过 —— 说明是首次启动，需要门禁引导。
ipcMain.handle('needs-data-path-setup', async () => {
  // 如果用户已显式保存过 dataPath 配置，视为已配置
  try {
    await fs.stat(APP_CONFIG_FILE);
    return false;
  } catch {}
  // currentDataDir 为空说明尚未初始化，且上面 APP_CONFIG_FILE 也不存在 → 需要设置
  if (!currentDataDir) return true;
  // 如果默认数据目录已存在会话数据（可能是开发时沿用默认路径），视为已配置
  try {
    await fs.stat(CHAT_INDEX_FILE);
    return false;
  } catch {}
  try {
    await fs.stat(SESSIONS_DIR);
    return false;
  } catch {}
  return true;
});

ipcMain.handle('read-settings', async () => {
  return await readFile(SETTINGS_FILE, null);
});

ipcMain.handle('write-settings', async (event, data) => {
  await writeFile(SETTINGS_FILE, data);
});

ipcMain.handle('read-chat-history', async () => {
  // ── v4 拆分格式优先 ──
  try {
    await fs.stat(SESSIONS_DIR);
    console.log('[chat-history] 使用 v4 拆分格式加载');
    return await readSessionsFromNewFormat();
  } catch {
    // sessions/ 目录不存在，尝试旧格式
  }

  // ── 旧格式兼容 ──
  const oldData = await readFile(CHAT_FILE, null);
  if (oldData && (oldData.sessions || oldData.messages)) {
    console.log('[chat-history] 检测到 v3 单文件格式，将在下次保存时自动迁移为 v4 拆分格式');
    return oldData;
  }

  // ── 全新启动 ──
  return { messages: [] };
});

ipcMain.handle('write-chat-history', async (event, data) => {
  // ── 增量模式（partial）：只写入变更的会话 + 更新索引 ──
  if (data && data.type === 'partial') {
    const { sessions = {}, sessionOrder = [], currentSessionId, deletedIds = [] } = data;

    // 仅写入变更的会话文件（不调用 writeSessionsToNewFormat，
    // 因为它的"孤立文件清理"逻辑会误删所有非脏会话文件）
    if (Object.keys(sessions).length > 0) {
      await ensureDir(SESSIONS_DIR);
      await Promise.all(
        Object.entries(sessions).map(async ([sid, session]) => {
          await writeFile(path.join(SESSIONS_DIR, `${sid}.json`), session);
        })
      );
    }

    // 删除已移除的会话文件
    for (const sid of deletedIds) {
      await fs.unlink(path.join(SESSIONS_DIR, `${sid}.json`)).catch(() => {});
    }
    // 清理索引中已删除的会话
    const cleanOrder = deletedIds.length > 0
      ? sessionOrder.filter(id => !deletedIds.includes(id))
      : sessionOrder;

    // 更新索引
    await writeFile(CHAT_INDEX_FILE, { sessionOrder: cleanOrder, currentSessionId });
    return;
  }

  // ── 全量模式（兼容旧调用 / 首次迁移） ──
  const { sessions = {}, sessionOrder = [], currentSessionId } = data;

  await writeSessionsToNewFormat(sessions, sessionOrder, currentSessionId);

  if (await fileExists(CHAT_FILE)) {
    const bakPath = CHAT_FILE + '.v3-backup';
    try {
      await fs.rename(CHAT_FILE, bakPath);
      console.log('[chat-history] v3 单文件已备份至 chat-history.json.v3-backup');
    } catch (e) {
      console.warn('[chat-history] v3 备份失败:', e.message);
    }
  }
});

ipcMain.handle('get-data-path', () => {
  return currentDataDir;
});

// ═══════════════════════════════════════════════════════════
// 统一工具执行 IPC（替代所有 mcp-* 通道）
// 所有 MCP 工具调用通过此单一通道进入，由 toolExecutor 路由
// ═══════════════════════════════════════════════════════════

ipcMain.handle('tool-execute', async (event, toolName, args, sessionId) => {
  return toolExecutor.execute(toolName, args, sessionId, {
    currentDataDir,
    batchManager,
    lockManager,
    codeTools,
    pythonSandbox,
  });
});

// ── 批量事务 + 恢复清单 IPC（基础设施，非工具调用）──

// ═══ 渲染进程完成保存后，触发主进程执行备份 + 重命名 ═══
ipcMain.handle('mcp-finalize-commit', async (event, commitId, sessionsSnapshot) => {
  const meta = batchManager.getCommitMeta(commitId);
  if (!meta) {
    return { error: '无效的 commitId 或提交已过期' };
  }
  batchManager.deleteCommitMeta(commitId);

  const { commitDir, description, sessionId } = meta;
  const sourceEntries = meta.sourceEntries.map(({ path: fp, tempPath }) => [fp, { tempPath, content: '' }]);

  // 更新恢复清单
  if (sessionsSnapshot && sessionsSnapshot.length > 0) {
    batchManager.setRecoveryList(commitId, sessionsSnapshot);
  }

  try {
    const { filesMeta } = await batchManager.backupOriginalFiles(
      commitDir, sourceEntries, description, sessionId
    );
    const results = await batchManager.finalizeCommit(sourceEntries);
    console.log(`[batch] 提交完成，${results.length} 个文件已写入`);

    // 短暂等待文件系统刷新（Vite HMR 通常在 100-500ms 内完成）
    await new Promise(resolve => setTimeout(resolve, 300));
    lockManager.releaseSessionDirLocks(sessionId);

    return {
      error: null,
      message: `批量提交完成：${results.filter(r => r.status === 'ok').length} 个成功`,
      results,
      commitDir,
    };
  } catch (err) {
    console.error('[batch] 提交失败:', err.message);
    lockManager.releaseSessionDirLocks(sessionId);
    return { error: err.message };
  }
});

// ═══ 检查+清除恢复清单 IPC ═══
ipcMain.handle('check-recovery-list', async () => {
  const sessions = batchManager.getRecoveryList();
  return { sessions: sessions || null };
});

ipcMain.handle('mcp-clear-recovery-list', async (event, commitId) => {
  batchManager.clearRecoveryList(commitId);
  return { success: true };
});

// ── 自动提交通知确认 IPC ──
// 渲染进程在完成提示消息插入后调用此接口，携带会话快照，
// 主进程收到后立即执行 backupOriginalFiles + finalizeCommit
ipcMain.handle('mcp-auto-commit-notify-done', async (event, sessionId, sessionsSnapshot) => {
  const notifies = batchManager.getPendingAutoCommitNotifies();
  const resolve = notifies.get(sessionId);
  if (resolve) {
    resolve();
    notifies.delete(sessionId);
  }

  // ═══ 执行自动提交：使用 scheduleSafetyCommit 中暂存的数据 ═══
  const sourceEntries = batchManager.pendingAutoCommitSourceEntries;
  const commitDir = batchManager.pendingAutoCommitCommitDir;
  const commitId = batchManager.pendingAutoCommitCommitId;

  if (sourceEntries && sourceEntries.length > 0) {
    // 存储恢复清单
    if (sessionsSnapshot && sessionsSnapshot.length > 0) {
      batchManager.setRecoveryList(commitId, sessionsSnapshot);
    }

    try {
      await batchManager.backupOriginalFiles(
        commitDir, sourceEntries, '(auto-commit: 安全超时触发)', sessionId
      );
      const results = await batchManager.finalizeCommit(sourceEntries);
      console.log(`[batch] 自动提交完成，${results.length} 个文件已写入`);

      await new Promise(r => setTimeout(r, 2000));
      lockManager.releaseSessionDirLocks(sessionId);
    } catch (err) {
      console.error('[batch] 自动提交失败:', err.message);
      lockManager.releaseSessionDirLocks(sessionId);
    }
  }

  // 清理暂存状态
  batchManager.pendingAutoCommitSessions = null;
  batchManager.pendingAutoCommitCommitId = null;
  batchManager.pendingAutoCommitSourceEntries = null;
  batchManager.pendingAutoCommitCommitDir = null;

  return { success: true };
});

// ── 渲染进程 → 主进程日志转发 ──
// Vite HMR 刷新会销毁渲染进程及其控制台，因此恢复相关的诊断日志
// 通过此 IPC 转发到主进程输出，确保持久可见。
ipcMain.on('log-to-main', (_event, level, message) => {
  const logger = console[level] || console.log;
  logger.call(console, message);
});

// ── 目录写锁 IPC → 已提取至 lockManager.js ──

ipcMain.handle('mcp-get-dir-lock-state', async () => {
  return lockManager.getDirLocksState();
});

ipcMain.handle('mcp-acquire-dir-locks', async (event, sessionId, filePaths, allowedDirs) => {
  const blocked = [];
  const acquired = [];
  const acquiredFiles = [];
  for (const fp of filePaths) {
    const targetDir = lockManager.findTargetDir(fp, allowedDirs);
    if (!targetDir) continue;
    const result = lockManager.acquireDirLock(targetDir, sessionId);
    if (result.acquired) {
      acquired.push(targetDir);
      acquiredFiles.push(fp);
    } else {
      blocked.push({ filePath: fp, dir: targetDir, holder: result.holder });
    }
  }
  if (blocked.length > 0 && acquired.length > 0) {
    for (const dir of acquired) {
      lockManager.releaseDirLockAndNotify(dir);
    }
  } else {
    for (const fp of acquiredFiles) {
      lockManager.recordLockedFile(sessionId, fp);
    }
  }
  return { status: blocked.length === 0 ? 'acquired' : 'blocked', acquired, blocked };
});

ipcMain.handle('mcp-wait-for-dir-locks', async (event, sessionId, blocked) => {
  for (const { dir } of blocked) {
    await lockManager.waitForDirLock(dir, sessionId);
  }
  return { status: 'acquired' };
});

ipcMain.handle('mcp-cancel-wait-for-locks', async (event, sessionId) => {
  lockManager.cleanupSessionFromWaiters(sessionId);
  return { status: 'cancelled' };
});

ipcMain.handle('mcp-release-dir-locks', async (event, sessionId) => {
  const released = lockManager.releaseSessionDirLocks(sessionId);
  return { released };
});

ipcMain.handle('mcp-wait-dir-lock-release', async (event, dirPath, sessionId) => {
  const key = lockManager.normalizeDir(dirPath);
  // 事件驱动等待：写锁释放时立即 resolve，替代原 100ms 轮询
  // 同时监听渲染进程断开事件（500ms 间隔检查），确保不泄漏
  const destroyedPromise = new Promise((_, reject) => {
    const check = () => {
      if (event.sender.isDestroyed()) {
        reject(new Error('RENDERER_DESTROYED'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });

  try {
    await Promise.race([
      lockManager.waitForReadUnlock(dirPath, sessionId),
      destroyedPromise,
    ]);
    return { status: 'ok' };
  } catch (err) {
    if (err.message === 'RENDERER_DESTROYED') {
      console.warn(`[lock] 读等待中止：渲染进程已断开 (sessionId=${sessionId}, dir=${key})`);
      return { status: 'cancelled' };
    }
    return { status: 'ok' }; // 兜底
  }
});

// ── 会话关闭通知 IPC ──

ipcMain.handle('mcp-notify-session-closed', async (event, sessionId) => {
  if (!sessionId) return { released: [] };
  const released = lockManager.releaseSessionDirLocks(sessionId);
  lockManager.cleanupSessionFromWaiters(sessionId);
  // 🐛 内存泄漏修复：清理该 session 的批量暂存区（pendingWrites + timer）
  //   此前仅释放了目录锁和等待队列，遗漏了 batchStates，导致未提交的暂存数据泄漏
  await batchManager.clearBatchCache(sessionId);
  return { released };
});

// ── 回滚功能 IPC ──

// ── Conda 环境扫描 IPC ──
// 列出所有可用的 Conda 环境名（用于 UI 下拉选择）

ipcMain.handle('mcp-list-conda-envs', async () => {
  try {
    const envs = await pythonSandbox.listCondaEnvs();
    return { error: null, envs };
  } catch (err) {
    return { error: err.message, envs: [] };
  }
});

// ── Web 工具 IPC ──
// 通过 HTTP/HTTPS 获取网页内容或网络文件
// 安全限制：仅 GET、禁止内网地址、超时/大小限制、重定向次数限制

const http = require('http');
const https = require('https');

/** 检查是否为内网 IP */
function isPrivateIP(hostname) {
  // IPv4 内网范围
  const privateRanges = [
    /^127\./,                          // 127.0.0.0/8
    /^10\./,                           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12
    /^192\.168\./,                     // 192.168.0.0/16
    /^0\./,                            // 0.0.0.0/8
    /^169\.254\./,                     // 169.254.0.0/16
    /^fc00:/,                          // IPv6 唯一本地地址
    /^fe80:/,                          // IPv6 链路本地地址
    /^::1$/,                           // IPv6 localhost
    /^::$/,                            // IPv6 未指定
  ];
  return privateRanges.some(r => r.test(hostname));
}

/** 从小体积 HTML 中提取 JS/Meta 跳转目标 URL */
function extractJSRedirect(html, currentUrl) {
  // 1. location.replace("URL") / location.href = "URL"
  const locMatch = html.match(/location\.(?:replace|href)\s*[=\(]\s*["']([^"']+)["']/);
  if (locMatch) return locMatch[1];

  // 2. Baidu 模式: location.replace(location.href.replace("https://","http://"))
  if (/location\.href\.replace\(["']https?:\/\/["']/.test(html)) {
    return currentUrl.replace(/^https:\/\//, 'http://');
  }

  // 3. <meta http-equiv="refresh" content="0;url=URL">
  const metaMatch = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s;]+)/i);
  if (metaMatch) return metaMatch[1];

  // 4. <noscript><meta http-equiv="refresh" content="0;url=URL">
  const noscriptMatch = html.match(/<noscript>\s*<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s;]+)/i);
  if (noscriptMatch) return noscriptMatch[1];

  return null;
}

/** 剥离 HTML 标签，提取纯文本，保留链接信息 */
function stripHtmlContent(html) {
  // 1. 移除 script / style / noscript 块
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // 2. 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 3. 将 <a href="URL">text</a> 转为 [text](URL)，保留链接信息
  text = text.replace(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, url, inner) => {
    const linkText = inner.replace(/<[^>]+>/g, '').trim();
    if (!linkText) return '';
    // 处理相对 URL
    return `[${linkText}](${url})`;
  });

  // 4. 将块级标签替换为换行
  text = text.replace(/<\/?(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|table|ul|ol|dl|blockquote|pre|figure|figcaption|form|fieldset)[^>]*>/gi, '\n');

  // 5. 剥离所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 6. 解码常见 HTML 实体
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#x27;/g, '\'');
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  // 7. 逐行清理：去首尾空白，过滤纯空白行
  text = text.split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== '' && arr[i + 1] !== ''))
    .join('\n');

  return text;
}

ipcMain.handle('mcp-fetch-url', async (event, url, timeout, maxSize, stripHtml, sessionId) => {
  try {
    // ── 1. 校验 URL ──
    if (!url || typeof url !== 'string') {
      return { error: 'fetch_url 缺少必要参数: url（要访问的 http/https 地址）。' };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { error: `无效的 URL 格式: "${url}"。请提供合法的 http/https 地址。` };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { error: `不支持的协议 "${parsedUrl.protocol}"。fetch_url 仅支持 http:// 和 https://。` };
    }

    // ── 2. 禁止内网地址（防 SSRF）──
    if (isPrivateIP(parsedUrl.hostname)) {
      return { error: `安全限制：禁止访问内网地址 "${parsedUrl.hostname}"。如需访问本地文件请使用 read_file 工具。` };
    }

    // ── 3. 参数安全值 ──
    const safeTimeout = typeof timeout === 'number' && timeout > 0
      ? Math.min(timeout, 60) * 1000
      : 30000;
    const safeMaxSize = typeof maxSize === 'number' && maxSize > 0
      ? Math.min(maxSize, 5_000_000)
      : 500000;

    // ── 4. 发送 HTTP/HTTPS 请求（独立 setTimeout 兜底超时）──
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;

    const result = await new Promise((resolve) => {
      let settled = false;
      const safeResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      // 独立超时定时器（不依赖 socket timeout，兼容挂死场景）
      const timer = setTimeout(() => {
        req.destroy();
        safeResolve({ error: `请求超时（${Math.round(safeTimeout / 1000)}s），已中断。` });
      }, safeTimeout);

      const req = httpModule.get(parsedUrl, {
        headers: {
          'User-Agent': 'Bamboo/1.0 (MCP fetch_url tool)',
          'Accept': 'text/*, application/json, application/xml, */*',
        },
      }, (res) => {
        // 跟随重定向（最多 5 次）
        const redirectCodes = [301, 302, 303, 307, 308];
        let redirectCount = 0;

        const handleResponse = (response) => {
          if (redirectCodes.includes(response.statusCode) && response.headers.location) {
            redirectCount++;
            if (redirectCount > 5) {
              safeResolve({ error: '重定向次数过多（超过 5 次），已中止。' });
              return;
            }
            // 解析重定向 URL
            let redirectUrl = response.headers.location;
            try {
              redirectUrl = new URL(redirectUrl, url).href;
            } catch {
              safeResolve({ error: `无效的重定向地址: "${response.headers.location}"` });
              return;
            }
            const redirectProto = redirectUrl.startsWith('https://') ? https : http;
            redirectProto.get(redirectUrl, { timeout: safeTimeout }).on('response', handleResponse).on('error', (err) => {
              safeResolve({ error: `重定向请求失败: ${err.message}` });
            });
            return;
          }

          // ── 读取响应体 ──
          const chunks = [];
          let totalSize = 0;
          let exceeded = false;

          response.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize > safeMaxSize) {
              exceeded = true;
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });

          response.on('end', () => {
            if (exceeded) {
              // 返回已截断的部分
              const buffer = Buffer.concat(chunks);
              safeResolve({
                content: buffer.toString('utf-8'),
                statusCode: response.statusCode,
                contentType: response.headers['content-type'] || 'unknown',
                truncated: true,
                actualSize: totalSize,
                error: null,
              });
              return;
            }

            const buffer = Buffer.concat(chunks);
            const contentType = response.headers['content-type'] || '';

            // ── JS / meta 跳转壳检测（仅对小体积响应，自动跟随）──
            const MAX_JS_REDIRECT_SIZE = 5000;
            if (buffer.length < MAX_JS_REDIRECT_SIZE) {
              try {
                const body = buffer.toString('utf-8');
                // 检测是否极简跳转壳（百度等）
                if (buffer.length < 500 && /location|noscript/.test(body) && /https?:\/\//.test(body)) {
                  const dest = url.replace(/^https:\/\//, 'http://');
                  if (dest !== url && redirectCount < 5) {
                    redirectCount++;
                    http.get(dest, { timeout: safeTimeout })
                      .on('response', handleResponse)
                      .on('error', (err) => {
                        safeResolve({ error: `重定向失败: ${err.message}` });
                      });
                    return;
                  }
                }
                // 正则提取 JS/meta 跳转
                const jsRedirectUrl = extractJSRedirect(body, url);
                if (jsRedirectUrl && redirectCount < 5) {
                  redirectCount++;
                  const redirectProto = jsRedirectUrl.startsWith('https://') ? https : http;
                  redirectProto.get(jsRedirectUrl, { timeout: safeTimeout })
                    .on('response', handleResponse)
                    .on('error', (err) => {
                      safeResolve({ error: `JS/Meta 重定向请求失败: ${err.message}` });
                    });
                  return;
                }
              } catch (e) {
                // 跳转检测异常，忽略继续
              }
            }

            // 检查是否为可读文本类型
            const isText = /^text\//.test(contentType) ||
                           /^application\/json\b/.test(contentType) ||
                           /^application\/xml\b/.test(contentType) ||
                           /^application\/x-www-form-urlencoded/.test(contentType) ||
                           /^application\/javascript/.test(contentType) ||
                           /^application\/typescript/.test(contentType);

            if (buffer.length === 0) {
              safeResolve({
                content: '（空响应体）',
                statusCode: response.statusCode,
                contentType: contentType || 'unknown',
                truncated: false,
                error: null,
              });
            } else if (!isText && contentType) {
              safeResolve({
                content: `[非文本内容] Content-Type: ${contentType}，大小: ${buffer.length} 字节。该资源类型不适合文本显示，如需查看请直接在浏览器中打开: ${url}`,
                statusCode: response.statusCode,
                contentType,
                truncated: false,
                error: null,
              });
            } else {
              const rawContent = buffer.toString('utf-8');
              const isHtml = /^text\/html/.test(contentType) || /<[a-z][\s\S]*>/i.test(rawContent.slice(0, 500));
              const finalContent = (stripHtml !== false && isHtml) ? stripHtmlContent(rawContent) : rawContent;
              safeResolve({
                content: finalContent,
                statusCode: response.statusCode,
                contentType: contentType || 'unknown',
                truncated: false,
                error: null,
              });
            }
          });

          response.on('error', (err) => {
            safeResolve({ error: `读取响应失败: ${err.message}` });
          });
        };

        handleResponse(res);
      });

      req.on('error', (err) => {
        safeResolve({ error: `请求失败: ${err.message}` });
      });
    });

    return result;
  } catch (err) {
    return { error: err.message };
  }
});

// ═══════════════════════════════════════════════════════════
// 文件管理 IPC —— 导入文件存储到 file/ 目录
// ═══════════════════════════════════════════════════════════

/** 文件列表缓存，避免每次都读 file-manifest.json */
let fileManifestCache = null;
let fileManifestCacheTime = 0;
const FILE_MANIFEST_CACHE_TTL = 3000; // 3 秒

async function loadFileManifest() {
  const now = Date.now();
  if (fileManifestCache && (now - fileManifestCacheTime) < FILE_MANIFEST_CACHE_TTL) {
    return fileManifestCache;
  }
  try {
    const data = await fs.readFile(FILE_MANIFEST, 'utf-8');
    fileManifestCache = JSON.parse(data);
    fileManifestCacheTime = now;
    return fileManifestCache;
  } catch (err) {
    if (err.code === 'ENOENT') {
      fileManifestCache = { files: [] };
      fileManifestCacheTime = now;
      return { files: [] };
    }
    throw err;
  }
}

async function saveFileManifest(manifest) {
  fileManifestCache = manifest;
  fileManifestCacheTime = Date.now();
  await ensureDir(FILE_DIR);
  await fs.writeFile(FILE_MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
}

// 保存导入的文件（扁平存储，所有文件直放 FILE_DIR）
ipcMain.handle('file-save', async (event, meta) => {
  try {
    const { originalName, contentBase64, mimeType, sessionId, sessionTitle, messageId } = meta;
    if (!originalName || !contentBase64 || !sessionId) {
      return { error: '缺少必要参数: originalName, contentBase64, sessionId' };
    }

    await ensureDir(FILE_DIR);

    // 生成安全文件名：{时间戳}_{sessionId前6位}_{清理后的原文件名}
    const shortId = sessionId.slice(0, 6);
    const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const timestamp = Date.now();
    const storedName = `${timestamp}_${shortId}_${safeName}`;
    const filePath = path.join(FILE_DIR, storedName);

    // 解码 base64 并写入原始二进制文件
    const buffer = Buffer.from(contentBase64, 'base64');
    await fs.writeFile(filePath, buffer);

    // 更新 manifest
    const manifest = await loadFileManifest();
    manifest.files.push({
      filePath,
      originalName,
      size: buffer.length,
      mimeType: mimeType || 'application/octet-stream',
      sessionId,
      sessionTitle: sessionTitle || '',
      messageId: messageId || '',
      importedAt: timestamp,
    });
    await saveFileManifest(manifest);

    console.log(`[file] 已保存: ${originalName} → ${storedName} (${buffer.length} bytes)`);
    return { error: null, filePath };
  } catch (err) {
    console.error('[file] 保存失败:', err);
    return { error: err.message };
  }
});

// 获取文件列表
ipcMain.handle('file-list', async () => {
  try {
    const manifest = await loadFileManifest();
    return { files: manifest.files, error: null };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

// 删除文件
ipcMain.handle('file-delete', async (event, filePath) => {
  try {
    if (!filePath) return { error: '缺少参数: filePath' };

    // 从 manifest 中移除
    const manifest = await loadFileManifest();
    const idx = manifest.files.findIndex((f) => f.filePath === filePath);
    if (idx === -1) return { error: '文件不在索引中' };
    manifest.files.splice(idx, 1);
    await saveFileManifest(manifest);

    // 删除磁盘上的文件
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[file] 删除磁盘文件失败:', err);
    }

    console.log(`[file] 已删除: ${filePath}`);
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
});

// 读取文件内容（文本返回 utf-8，二进制返回 base64 用于下载）
ipcMain.handle('file-read', async (event, filePath) => {
  try {
    if (!filePath) return { content: null, error: '缺少参数: filePath' };
    const buffer = await fs.readFile(filePath);
    // 尝试以 utf-8 解码，成功则返回字符串，失败则返回 base64
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { content: text, error: null, encoding: 'utf-8' };
    } catch {
      const base64 = buffer.toString('base64');
      return { content: base64, error: null, encoding: 'base64' };
    }
  } catch (err) {
    return { content: null, error: err.message };
  }
});

// ═══════════════════════════════════════════════════════════
// 用户工具清单 IPC — 扫描 {dataDir}/tools/user/ 目录
// ═══════════════════════════════════════════════════════════

ipcMain.handle('list-user-tool-manifests', async () => {
  try {
    const userToolsDir = path.join(currentDataDir, 'tools', 'user');
    const manifests = [];

    try {
      await fs.access(userToolsDir);
    } catch {
      // 目录不存在，返回空列表
      return { error: null, manifests: [] };
    }

    const entries = await fs.readdir(userToolsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(userToolsDir, entry), 'utf-8');
        const manifest = JSON.parse(content);
        if (manifest && manifest.name) {
          manifests.push(manifest);
        }
      } catch (err) {
        console.warn(`[tool] 跳过无效清单: ${entry}`, err.message);
      }
    }

    return { error: null, manifests };
  } catch (err) {
    return { error: err.message, manifests: [] };
  }
});
