// ── 批量写入事务系统（HMR-safe batch write）────────────────
// 每个 session 独立维护批量状态，防止多角色/多会话并发互相污染
//
// 用法（在 main.js 中）：
//   const batchManager = require('./batchManager');
//   在 createWindow 之后调用 batchManager.init(currentDataDir, mainWindow);
//   将所有 getOrCreateBatch / readFileWithPending / writeFileBatchAware /
//   scheduleSafetyCommit / commitBatch / clearBatchCache / safeRelativePath /
//   isPathAllowed / cleanupStalePending 替换为 batchManager.xxx
//
// ═══ 协调式提交流程（HMR-safe coordinated commit）══════
// 流程由渲染进程驱动，主进程存储恢复清单（主进程不被 Vite 刷新销毁）：
//   ① 渲染进程: flushAndSave → 收集活跃会话快照
//   ② 渲染进程: IPC mcp-finalize-commit(sessionsSnapshot) → 主进程
//   ③ 主进程: 存储恢复清单 → backupOriginalFiles → finalizeCommit
//   ④ Vite 可能触发 full-reload（src/ 下文件被修改时）
//   ⑤ 新渲染进程: check-recovery-list → 获取恢复清单 → 逐个恢复
//
// recoveryList 存储在主进程内存中，TTL 15 秒自毁。
// 若 Vite 刷新 → 新渲染进程在 ~1-2s 内查询。若未刷新 → 渲染进程主动清除。

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const lockManager = require('./lockManager');

const BATCH_SAFETY_TIMEOUT_MS = 1_800_000; // 30 分钟无操作自动提交
const MAX_READ_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const RECOVERY_LIST_TTL_MS = 15_000; // 恢复清单 TTL 15 秒

const batchStates = new Map(); // sessionId → { pendingWrites: Map, timer }
const pendingAutoCommitNotifies = new Map(); // sessionId → resolve()

/**
 * 恢复清单：主进程内存中存储。
 * 渲染进程在 finalize-commit 前传入会话快照，主进程在 rename 后持有。
 * TTL 15 秒：若 Vite 刷新 → 新渲染进程 1-2s 内查询；若未刷新 → 渲染进程主动清除。
 *
 * commitId → { sessions: Array<{sessionId, activeLeafId}>, timer: NodeJS.Timeout }
 */
const recoveryList = new Map();

/**
 * 提交元数据暂存：mcp-batch-commit 执行 prepareCommit 后暂存，
 * 供 mcp-finalize-commit 使用（因为 prepareCommit 已清空暂存区）。
 * commitId → { sourceEntries, commitDir, description, sessionId }
 */
const commitMeta = new Map();

function storeCommitMeta(commitId, meta) {
  commitMeta.set(commitId, meta);
  // TTL 30 秒自毁（防御：若渲染进程从不调用 finalize-commit）
  setTimeout(() => { commitMeta.delete(commitId); }, 30_000);
}

function getCommitMeta(commitId) {
  return commitMeta.get(commitId);
}

function deleteCommitMeta(commitId) {
  commitMeta.delete(commitId);
}

let currentDataDir = null;
let mainWindowRef = null;

function generateId() {
  return crypto.randomBytes(12).toString('hex');
}

// ── 恢复清单管理 ───────────────────────────────────────────

function setRecoveryList(commitId, sessions) {
  const timer = setTimeout(() => {
    recoveryList.delete(commitId);
    console.log(`[batch] 恢复清单 ${commitId} TTL 过期，已清除`);
  }, RECOVERY_LIST_TTL_MS);
  recoveryList.set(commitId, { sessions, timer });
  console.log(`[batch] 恢复清单已存储: commitId=${commitId}, ${sessions.length} 个会话`);
}

function getRecoveryList() {
  if (recoveryList.size === 0) return null;

  const allSessions = [];
  const seenIds = new Map(); // sessionId → sourceCommit

  for (const [commitId, entry] of recoveryList.entries()) {
    clearTimeout(entry.timer);
    recoveryList.delete(commitId);
    for (const s of entry.sessions) {
      if (!seenIds.has(s.sessionId)) {
        seenIds.set(s.sessionId, s.sourceCommit || false);
        allSessions.push(s);
      } else if (s.sourceCommit) {
        // 其他 commit 中该 session 是源 → 更新标志
        seenIds.set(s.sessionId, true);
        const existing = allSessions.find((e) => e.sessionId === s.sessionId);
        if (existing) existing.sourceCommit = true;
      }
    }
  }

  console.log(`[batch] 恢复清单已取出: ${allSessions.length} 个会话`);
  return allSessions;
}

function clearRecoveryList(commitId) {
  const entry = recoveryList.get(commitId);
  if (entry) {
    clearTimeout(entry.timer);
    recoveryList.delete(commitId);
    console.log(`[batch] 恢复清单已清除: commitId=${commitId}`);
  }
}

function init(dataDir, mainWindow) {
  currentDataDir = dataDir;
  mainWindowRef = mainWindow;
}

function updateDataDir(dataDir) {
  currentDataDir = dataDir;
}

function getOrCreateBatch(sessionId) {
  if (!sessionId) return null;
  let state = batchStates.get(sessionId);
  if (!state) {
    state = { pendingWrites: new Map(), timer: null };
    batchStates.set(sessionId, state);
  }
  return state;
}

// ── 短期文件读取缓存（TTL 5 秒），避免同一轮工具调用中重复读取同一文件 ──
const readCache = new Map(); // filePath → { content, mtimeMs, cachedAt }

async function readFileWithPending(filePath, sessionId) {
  if (sessionId) {
    const state = batchStates.get(sessionId);
    if (state && state.pendingWrites.has(filePath)) {
      return state.pendingWrites.get(filePath).content;
    }
  }

  // 检查短期缓存（TTL 5s），若 mtime 未变则直接返回
  const cached = readCache.get(filePath);
  const now = Date.now();
  if (cached && (now - cached.cachedAt) < 5000) {
    try {
      const currentStat = await fs.stat(filePath);
      if (currentStat.mtimeMs === cached.mtimeMs) {
        return cached.content;
      }
    } catch { /* 文件可能已被删除，继续读取 */ }
  }

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_READ_FILE_SIZE) {
    throw Object.assign(new Error(
      `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_READ_FILE_SIZE / 1024 / 1024}MB 读取上限。请使用 search 工具搜索特定内容。`
    ), { code: 'FILE_TOO_LARGE' });
  }

  const content = await fs.readFile(filePath, 'utf-8');
  // 存入缓存
  readCache.set(filePath, { content, mtimeMs: stat.mtimeMs, cachedAt: now });
  // 定期清理过期缓存（每 30 秒）
  if (readCache.size > 50) {
    for (const [k, v] of readCache) {
      if (now - v.cachedAt > 5000) readCache.delete(k);
    }
  }
  return content;
}

const readFileSafe = readFileWithPending;

async function writeFileBatchAware(filePath, content, sessionId) {
  if (sessionId) {
    const state = getOrCreateBatch(sessionId);
    const tempDir = path.join(currentDataDir, '.temp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempName = safeRelativePath(path.resolve(__dirname, '..'), filePath) +
      '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.pending';
    const tempPath = path.join(tempDir, tempName);
    await fs.writeFile(tempPath, content, 'utf-8');
    const prev = state.pendingWrites.get(filePath);
    if (prev) {
      try { await fs.unlink(prev.tempPath); } catch {}
    }
    state.pendingWrites.set(filePath, { tempPath, content });
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

function scheduleSafetyCommit(sessionId) {
  const state = batchStates.get(sessionId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    console.warn(`[batch] 安全超时（30分钟），session ${sessionId} 自动提交`);

    // ═══ 通知渲染进程：保存状态并在完成后回传会话快照 ═══
    if (mainWindowRef && !mainWindowRef.isDestroyed() && sessionId) {
      try {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            pendingAutoCommitNotifies.delete(sessionId);
            console.warn(`[batch] 自动提交通知超时（5s），session ${sessionId} 继续提交`);
            resolve();
          }, 5000);
          pendingAutoCommitNotifies.set(sessionId, () => {
            clearTimeout(timeout);
            resolve();
          });
          mainWindowRef.webContents.send('auto-commit-notify', sessionId);
        });
      } catch (e) {
        console.warn('[batch] 自动提交通知失败，继续执行提交:', e?.message || e);
      } finally {
        pendingAutoCommitNotifies.delete(sessionId);
      }
    }

    // ═══ prepareCommit（记账）═══
    const { commitDir, filesMeta, sourceEntries } = await prepareCommit(sessionId, null);

    if (sourceEntries.length === 0) {
      lockManager.releaseSessionDirLocks(sessionId);
      return;
    }

    // ═══ 若渲染进程仍存活，等待它回传会话快照；否则兜底 ═══
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      const commitId = `auto_${sessionId}_${Date.now()}`;

      // 等待渲染进程回传快照（由 auto-commit-notify-done IPC 触发）
      // 此处用 pendingAutoCommitSessions 暂存
      pendingAutoCommitSessions = null;
      pendingAutoCommitCommitId = commitId;
      pendingAutoCommitSourceEntries = sourceEntries;
      pendingAutoCommitCommitDir = commitDir;

      mainWindowRef.webContents.send('auto-commit-prepared', { commitId, sessionId });
      // 后续在 mcp-auto-commit-notify-done 中继续执行
    } else {
      // 兜底：渲染进程不可用，同步执行
      await backupOriginalFiles(commitDir, sourceEntries, '(auto-commit: 安全超时触发)', sessionId);
      await finalizeCommit(sourceEntries);
      await new Promise(r => setTimeout(r, 2000));
      lockManager.releaseSessionDirLocks(sessionId);
    }
  }, BATCH_SAFETY_TIMEOUT_MS);
}

// auto-commit 待处理状态（渲染进程回传快照后使用）
let pendingAutoCommitSessions = null;
let pendingAutoCommitCommitId = null;
let pendingAutoCommitSourceEntries = null;
let pendingAutoCommitCommitDir = null;

/**
 * 阶段 0：记账（计算路径 + 收集文件列表 + 清空 buffer，不执行备份或重命名）
 *
 * 与旧版本的关键区别：
 *   - 不读取原文件（备份延迟到 backupOriginalFiles）
 *   - 不创建 commitDir 目录（延迟到 backupOriginalFiles）
 *   - 不写入 commit.json（延迟到 backupOriginalFiles）
 *
 * 返回 { commitDir, filesMeta, sourceEntries }
 */
async function prepareCommit(sessionId, name, description) {
  const state = batchStates.get(sessionId);
  if (!state) return { commitDir: null, filesMeta: [], sourceEntries: [] };

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const projectRoot = path.resolve(__dirname, '..');

  let commitDir = null;
  const filesMeta = [];

  if (state.pendingWrites.size > 0) {
    const now = new Date();
    const dateDir = now.getFullYear() +
      '-' + String(now.getMonth() + 1).padStart(2, '0') +
      '-' + String(now.getDate()).padStart(2, '0');
    const timeStr =
      String(now.getHours()).padStart(2, '0') +
      '-' + String(now.getMinutes()).padStart(2, '0') +
      '-' + String(now.getSeconds()).padStart(2, '0');
    const safeName = (name || 'no-name').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 40);
    const commitName = `commit_${timeStr}_${safeName}`;
    commitDir = path.join(currentDataDir, '.backups', dateDir, commitName);
    // 目录创建延迟到 backupOriginalFiles

    for (const [filePath] of state.pendingWrites) {
      filesMeta.push(path.relative(projectRoot, filePath));
    }
  }

  // 取出所有待重命名的源条目
  const sourceEntries = [...state.pendingWrites.entries()];

  // 清空 buffer（标记提交已完成记账，后续不会再触发自动提交）
  state.pendingWrites.clear();
  batchStates.delete(sessionId);

  return { commitDir, filesMeta, sourceEntries };
}

/**
 * 备份原文件：在 finalizeCommit 前读取原文件 → 写入 .backups/ → 写入 commit.json
 *
 * 此函数应在协调器暂停所有会话后、finalizeCommit 之前调用，
 * 确保备份与提交之间的窗口内不会有其他会话修改文件。
 */
async function backupOriginalFiles(commitDir, sourceEntries, description, sessionId) {
  const projectRoot = path.resolve(__dirname, '..');
  const newFiles = [];

  if (sourceEntries.length === 0) return { filesMeta: [], newFiles };

  await fs.mkdir(commitDir, { recursive: true });

  // 并行备份所有原文件（彼此独立，无依赖关系）
  const results = await Promise.all(
    sourceEntries.map(async ([filePath]) => {
      const relativePath = safeRelativePath(projectRoot, filePath);
      const destBackup = path.join(commitDir, relativePath + '.bak');
      try {
        const originalContent = await fs.readFile(filePath, 'utf-8');
        await fs.writeFile(destBackup, originalContent, 'utf-8');
        return { meta: path.relative(projectRoot, filePath), isNew: false };
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { meta: path.relative(projectRoot, filePath), isNew: true };
        } else {
          console.error('[commit] 备份原文件失败:', filePath, err.message);
          return { meta: path.relative(projectRoot, filePath), isNew: false, failed: true };
        }
      }
    })
  );

  const filesMeta = results
    .filter(r => !r.failed)
    .map(r => {
      if (r.isNew) newFiles.push(r.meta);
      return r.meta;
    });

  const commitMeta = {
    description: description || '(auto-commit: 安全超时触发)',
    timestamp: new Date().toISOString(),
    sessionId,
    files: filesMeta,
    newFiles,
  };
  await fs.writeFile(
    path.join(commitDir, 'commit.json'),
    JSON.stringify(commitMeta, null, 2),
    'utf-8'
  );

  return { filesMeta, newFiles };
}

/**
 * 阶段 2：执行文件重命名（将暂存文件移动到目标路径，触发 Vite HMR）
 *
 * 所有 rename 通过 Promise.all 并行执行，让 chokidar 在同一轮事件循环中
 * 检测到所有变更，Vite 将它们合并为一次 full-reload，避免级联刷新。
 */
async function finalizeCommit(sourceEntries) {
  const renameOne = async ([targetPath, { tempPath }]) => {
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.rename(tempPath, targetPath);
      return { path: targetPath, status: 'ok' };
    } catch (err) {
      if (err.code === 'EXDEV') {
        try {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.copyFile(tempPath, targetPath);
          await fs.unlink(tempPath);
          return { path: targetPath, status: 'ok' };
        } catch (copyErr) {
          return { path: targetPath, status: 'error', error: copyErr.message };
        }
      } else {
        try { await fs.unlink(tempPath); } catch {}
        return { path: targetPath, status: 'error', error: err.message };
      }
    }
  };

  return Promise.all(sourceEntries.map(renameOne));
}

/** 
 * 保持向后兼容：原 commitBatch 函数 = prepareCommit + backupOriginalFiles + finalizeCommit 
 * （用于兜底场景，如渲染进程不可用时。正常流程应使用协调式提交。）
 */
async function commitBatch(sessionId, name, description) {
  const { commitDir, filesMeta, sourceEntries } = await prepareCommit(sessionId, name, description);
  const desc = description || '(auto-commit: 安全超时触发)';
  await backupOriginalFiles(commitDir, sourceEntries, desc, sessionId);
  const results = await finalizeCommit(sourceEntries);
  return { results, commitDir, filesMeta };
}

async function clearBatchCache(sessionId) {
  const state = batchStates.get(sessionId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  for (const [, { tempPath }] of state.pendingWrites) {
    try { await fs.unlink(tempPath); } catch {}
  }
  batchStates.delete(sessionId);
}

function safeRelativePath(projectRoot, absolutePath) {
  let rel = path.relative(projectRoot, absolutePath);
  // 跨盘符时 path.relative 返回绝对路径（Windows），降级为仅用 basename
  if (path.isAbsolute(rel)) {
    rel = path.basename(absolutePath);
  }
  return rel.replace(/[/\\]/g, '__').replace(/[<>:"|?*]/g, '_');
}

function isPathAllowed(targetPath, allowedDirs) {
  if (!allowedDirs || allowedDirs.length === 0) return false;
  const normalized = targetPath.replace(/\\/g, '/');
  return allowedDirs.some(dir => {
    const base = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return normalized === base.slice(0, -1) || normalized.startsWith(base);
  });
}

async function cleanupStalePending() {
  const tempDir = path.join(currentDataDir, '.temp');
  try {
    const files = await fs.readdir(tempDir);
    for (const f of files) {
      try {
        await fs.unlink(path.join(tempDir, f));
        console.log('[cleanup] 已清理残留:', f);
      } catch (err) {
        console.error('[cleanup] 清理失败:', f, err.message);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[cleanup] 无法访问临时目录:', err.message);
    }
  }
}

module.exports = {
  init,
  updateDataDir,
  getOrCreateBatch,
  readFileWithPending,
  readFileSafe,
  writeFileBatchAware,
  scheduleSafetyCommit,
  commitBatch,
  prepareCommit,       // 记账 + 清空暂存
  backupOriginalFiles, // 备份原文件
  finalizeCommit,      // 原子重命名（触发 Vite HMR）
  clearBatchCache,
  safeRelativePath,
  isPathAllowed,
  cleanupStalePending,
  getPendingAutoCommitNotifies: () => pendingAutoCommitNotifies,
  getBatchStates: () => batchStates,
  hasBatch: (sessionId) => batchStates.has(sessionId),
  generateId,
  // ── 提交元数据暂存（prepareCommit → finalizeCommit 之间）──
  storeCommitMeta,
  getCommitMeta,
  deleteCommitMeta,
  // ── 恢复清单（新）：主进程内存存储，Vite 刷新后新渲染进程查询 ──
  setRecoveryList,
  getRecoveryList,
  clearRecoveryList,
  // ── auto-commit 待处理状态 ──
  get pendingAutoCommitSessions() { return pendingAutoCommitSessions; },
  set pendingAutoCommitSessions(v) { pendingAutoCommitSessions = v; },
  get pendingAutoCommitCommitId() { return pendingAutoCommitCommitId; },
  set pendingAutoCommitCommitId(v) { pendingAutoCommitCommitId = v; },
  get pendingAutoCommitSourceEntries() { return pendingAutoCommitSourceEntries; },
  set pendingAutoCommitSourceEntries(v) { pendingAutoCommitSourceEntries = v; },
  get pendingAutoCommitCommitDir() { return pendingAutoCommitCommitDir; },
  set pendingAutoCommitCommitDir(v) { pendingAutoCommitCommitDir = v; },
};
