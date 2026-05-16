// ── 层级目录写锁系统（跨会话、跨角色） ──────────────────────
// 防止同一允许目录（及其子孙目录）下的文件被多个会话同时写入。
//
// 核心规则：
//   锁 ./A 等价于锁住 ./A 及其所有子孙目录。
//   两个锁若有"祖先—后代"或"相等"关系即视为冲突。
//   兄弟目录（如 ./A/A1 与 ./A/A2）可以并行写入。
//
// 用法（在 main.js 中）：
//   const lockManager = require('./lockManager');
//   将所有 findTargetDir / acquireDirLock / releaseSessionDirLocks / waitForDirLock /
//   recordLockedFile / getLockedFilesForSession / cleanupSessionFromWaiters
//   替换为 lockManager.xxx

/** 规范化后的目录路径 → sessionId */
const dirLocks = new Map();
/** sessionId → Set<filePath>（记录具体改哪些文件，用于"[文件被修改]"替换） */
const lockedFiles = new Map();
/** 规范化后的目录路径 → Array<{ sessionId, resolve }>（写锁等待队列） */
const dirLockWaiters = new Map();
/** 规范化后的目录路径 → Array<{ sessionId, resolve }>（读等待队列，事件驱动，消除轮询延迟） */
const readWaiters = new Map();

/** 规范化目录路径：统一分隔符，去掉尾部斜杠 */
function normalizeDir(dirPath) {
  return dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 判断 a 是否是 b 的祖先目录（或自身）。
 *   用 exact + '/' 前缀判断，避免 './A' 误匹配 './AB'。
 *   isAncestorOrSelf('./A', './A/A1') → true
 *   isAncestorOrSelf('./A/A1', './A') → false
 *   isAncestorOrSelf('./A', './A')   → true
 *   isAncestorOrSelf('./A', './AB')  → false
 */
function isAncestorOrSelf(a, b) {
  const ancestor = normalizeDir(a);
  const descendant = normalizeDir(b);
  if (ancestor === descendant) return true;
  return descendant.startsWith(ancestor + '/');
}

/**
 * 判断两个目录是否有层级重叠（一个是另一个的祖先/后代/相等）。
 */
function overlapsWith(a, b) {
  return isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a);
}

/** 从文件路径找到所属的允许目录（最长匹配，避免顺序敏感和字符串前缀误匹配） */
function findTargetDir(filePath, allowedDirs) {
  const normalized = filePath.replace(/\\/g, '/');
  let bestMatch = null;
  let bestLen = 0;
  for (const dir of allowedDirs) {
    const dirNorm = normalizeDir(dir);
    if (normalized === dirNorm || normalized.startsWith(dirNorm + '/')) {
      if (dirNorm.length > bestLen) {
        bestMatch = dirNorm;
        bestLen = dirNorm.length;
      }
    }
  }
  return bestMatch;
}

/** 尝试获取层级目录写锁 */
function acquireDirLock(dirPath, sessionId) {
  const key = normalizeDir(dirPath);

  // 遍历所有已持锁，检测层级冲突（祖先/后代/相等）
  for (const [lockedDir, holder] of dirLocks) {
    if (holder === sessionId) continue; // 同 session 可重入
    if (overlapsWith(key, lockedDir)) {
      return { acquired: false, holder, conflictDir: lockedDir };
    }
  }

  dirLocks.set(key, sessionId);
  return { acquired: true };
}

/**
 * 唤醒所有等待队列中已无冲突的等待者（FIFO，每个目录每次唤醒一个）。
 * 释放锁后可能有多个等待者同时解除阻塞。
 * 外层 while 确保同目录队列的后续等待者也能被检查（如同 session 可重入）。
 */
function wakeEligibleWaiters() {
  let wokeAny = true;
  while (wokeAny) {
    wokeAny = false;
    for (const [dirPath, queue] of dirLockWaiters) {
      if (queue.length === 0) continue;
      const waiter = queue[0];
      let blocked = false;
      for (const [lockedDir, holder] of dirLocks) {
        if (holder === waiter.sessionId) continue;
        if (overlapsWith(dirPath, lockedDir)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        queue.shift();
        dirLocks.set(dirPath, waiter.sessionId);
        if (queue.length === 0) dirLockWaiters.delete(dirPath);
        waiter.resolve();
        wokeAny = true;
      }
    }
  }
}

/** 释放指定 session 持有的所有目录锁，并通知等待者（层级锁的连锁反应） */
function releaseSessionDirLocks(sessionId) {
  const released = [];
  for (const [dirPath, holder] of dirLocks) {
    if (holder === sessionId) {
      dirLocks.delete(dirPath);
      released.push(dirPath);
    }
  }
  lockedFiles.delete(sessionId);
  cleanupSessionFromWaiters(sessionId);

  // 先通知所有涉及目录的读等待者（事件驱动，零延迟）
  for (const dirPath of released) {
    notifyReadWaiters(dirPath);
  }

  // 唤醒已无冲突的写等待者（可能有多个，层级锁的连锁反应）
  wakeEligibleWaiters();

  return released;
}

/** 注册等待（返回 Promise，锁可用时 resolve） */
function waitForDirLock(dirPath, sessionId) {
  return new Promise(resolve => {
    const key = normalizeDir(dirPath);
    if (!dirLockWaiters.has(key)) dirLockWaiters.set(key, []);
    dirLockWaiters.get(key).push({ sessionId, resolve });
  });
}

/** 记录 session 正在修改的文件（用于排队解除后标记"[文件被修改]"） */
function recordLockedFile(sessionId, filePath) {
  if (!sessionId) return;
  if (!lockedFiles.has(sessionId)) lockedFiles.set(sessionId, new Set());
  lockedFiles.get(sessionId).add(filePath);
}

/** 获取指定 session 已记录的所有被修改文件路径 */
function getLockedFilesForSession(sessionId) {
  return lockedFiles.has(sessionId) ? [...lockedFiles.get(sessionId)] : [];
}

/** 从所有等待队列（写+读）中移除指定 session 的条目 */
function cleanupSessionFromWaiters(sessionId) {
  for (const [dirPath, queue] of dirLockWaiters) {
    const filtered = queue.filter(w => w.sessionId !== sessionId);
    if (filtered.length === 0) {
      dirLockWaiters.delete(dirPath);
    } else {
      dirLockWaiters.set(dirPath, filtered);
    }
  }
  for (const [dirPath, queue] of readWaiters) {
    const removed = queue.filter(w => w.sessionId === sessionId);
    const kept = queue.filter(w => w.sessionId !== sessionId);
    if (kept.length === 0) {
      readWaiters.delete(dirPath);
    } else {
      readWaiters.set(dirPath, kept);
    }
    // reject 被清理的读等待者，避免 Promise 悬挂
    for (const w of removed) {
      w.reject(new Error('SESSION_CLOSED'));
    }
  }
}

/** 获取所有目录锁的状态快照 */
function getDirLocksState() {
  const state = [];
  for (const [dirPath, holder] of dirLocks) {
    state.push({ dir: dirPath, holder });
  }
  return state;
}

/** 释放指定目录的锁（不通知等待队列） */
function releaseDirLock(dirPath, sessionId) {
  const key = normalizeDir(dirPath);
  if (dirLocks.get(key) === sessionId) {
    dirLocks.delete(key);
  }
}

/** 获取指定目录的锁持有者（含祖先锁检查），null 表示未锁定 */
function getLockState(key) {
  const normalized = normalizeDir(key);
  // 检查自身及所有祖先目录是否有锁
  for (const [lockedDir, holder] of dirLocks) {
    if (isAncestorOrSelf(lockedDir, normalized)) {
      return holder;
    }
  }
  return null;
}

/** 释放指定目录的锁并通知等待队列（层级锁版本：可能有多个等待者被唤醒） */
function releaseDirLockAndNotify(dirPath) {
  const key = normalizeDir(dirPath);
  dirLocks.delete(key);
  // 先通知所有涉及目录的读等待者（事件驱动，零延迟）
  notifyReadWaiters(key);
  // 唤醒已无冲突的写等待者（可能有多个）
  wakeEligibleWaiters();
}

/**
 * 事件驱动的读等待：注册一个读等待者，当写锁释放时立即 resolve
 * 替代原来的 100ms 轮询，消除 0-100ms 的随机延迟
 */
function waitForReadUnlock(dirPath, sessionId) {
  return new Promise((resolve, reject) => {
    const key = normalizeDir(dirPath);
    // 锁已释放或持有者是自己 → 立即返回
    const state = getLockState(key);
    if (!state || state === sessionId) {
      resolve();
      return;
    }
    if (!readWaiters.has(key)) readWaiters.set(key, []);
    readWaiters.get(key).push({ sessionId, resolve, reject });
  });
}

/** 通知指定目录的所有读等待者（含子孙目录，层级锁的连锁反应） */
function notifyReadWaiters(dirPath) {
  const key = normalizeDir(dirPath);
  // 收集所有需要通知的目录（自身 + 所有子孙）
  const toNotify = [key];
  for (const waiterDir of readWaiters.keys()) {
    if (isAncestorOrSelf(key, waiterDir) && key !== waiterDir) {
      toNotify.push(waiterDir);
    }
  }
  // 通知所有受影响目录的读等待者
  for (const dir of toNotify) {
    const queue = readWaiters.get(dir);
    if (queue && queue.length > 0) {
      for (const waiter of queue) {
        waiter.resolve();
      }
      readWaiters.delete(dir);
    }
  }
}

module.exports = {
  normalizeDir,
  findTargetDir,
  acquireDirLock,
  releaseSessionDirLocks,
  waitForDirLock,
  recordLockedFile,
  getLockedFilesForSession,
  cleanupSessionFromWaiters,
  getDirLocksState,
  releaseDirLock,
  releaseDirLockAndNotify,
  getLockState,
  waitForReadUnlock,
  notifyReadWaiters,
};
