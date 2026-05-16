// ============================================================
// 通用工具执行器 — 统一 MCP 工具 IPC 入口
//
// 所有工具调用通过单一道通 'tool-execute' 进入，
// 根据 toolName 路由到对应的 handler。
//
// 新增工具只需在 handlers 中添加一个条目，
// 无需新增 IPC 通道、无需改 preload、无需重启主进程。
// ============================================================

const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

/** 检查是否为内网 IP（防 SSRF） */
function isPrivateIP(hostname) {
  const privateRanges = [
    /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^0\./, /^169\.254\./, /^fc00:/, /^fe80:/, /^::1$/, /^::$/,
  ];
  return privateRanges.some(r => r.test(hostname));
}

/** 从小体积 HTML 中提取 JS/Meta 跳转目标 URL */
function extractJSRedirect(html, currentUrl) {
  const locMatch = html.match(/location\.(?:replace|href)\s*[=\(]\s*["']([^"']+)["']/);
  if (locMatch) return locMatch[1];
  if (/location\.href\.replace\(["']https?:\/\/["']/.test(html)) {
    return currentUrl.replace(/^https:\/\//, 'http://');
  }
  const metaMatch = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s;]+)/i);
  if (metaMatch) return metaMatch[1];
  const noscriptMatch = html.match(/<noscript>\s*<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s;]+)/i);
  if (noscriptMatch) return noscriptMatch[1];
  return null;
}

/** 剥离 HTML 标签，提取纯文本 */
function stripHtmlContent(html) {
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, url, inner) => {
    const linkText = inner.replace(/<[^>]+>/g, '').trim();
    return linkText ? `[${linkText}](${url})` : '';
  });
  text = text.replace(/<\/?(div|p|h[1-6]|li|tr|br|hr|section|article|header|footer|nav|main|aside|table|ul|ol|dl|blockquote|pre|figure|figcaption|form|fieldset)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'');
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== '' && arr[i + 1] !== ''))
    .join('\n');
  return text;
}

// ═══════════════════════════════════════════════════════════
// 工具 Handler 映射
// ═══════════════════════════════════════════════════════════

/** @type {Record<string, (args: any, sessionId: string|null, ctx: any) => Promise<any>>} */
const handlers = {};

// ── 文件读取工具 ──────────────────────────────────────────

handlers.read_file = async (args, sessionId, ctx) => {
  const { path: filePath, offset, limit } = args;
  const content = await ctx.batchManager.readFileWithPending(filePath, sessionId);
  const lines = content.split('\n');
  const totalLines = lines.length;

  const MAX_LINES = 2000;
  const DEFAULT_LINES = 75;
  const startIdx = (typeof offset === 'number' && offset >= 1) ? offset - 1 : 0;
  const safeLimit = (typeof limit === 'number' && limit > 0) ? Math.min(limit, MAX_LINES) : DEFAULT_LINES;
  const endIdx = Math.min(startIdx + safeLimit, totalLines);

  if (startIdx >= totalLines) {
    return { content: '', error: null, totalLines, startLine: offset || 1, endLine: offset || 1 };
  }
  const sliced = lines.slice(startIdx, endIdx);
  return {
    content: sliced.join('\n'), error: null,
    totalLines, startLine: startIdx + 1, endLine: endIdx,
  };
};

handlers.list_directory = async (args, sessionId, ctx) => {
  const { path: dirPath } = args;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return {
    entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    error: null,
  };
};

// ── 文件写入工具 ──────────────────────────────────────────

handlers.write_file = async (args, sessionId, ctx) => {
  const { path: filePath, content } = args;
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return { error: `文件已存在，write_file 仅限创建新文件: "${filePath}"。如需修改已有文件，请使用 modify_code 工具。` };
  } catch (accessErr) {
    if (accessErr.code !== 'ENOENT') throw accessErr;
  }
  if (!sessionId) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return { error: null };
  }
  if (!ctx.batchManager.hasBatch(sessionId)) {
    ctx.batchManager.getOrCreateBatch(sessionId);
  }
  ctx.batchManager.scheduleSafetyCommit(sessionId);
  await ctx.batchManager.writeFileBatchAware(filePath, content, sessionId);
  return { error: null };
};

// ── 文件复制 ──────────────────────────────────────────────

handlers.copy_file = async (args, sessionId, ctx) => {
  const { source, destination } = args;
  if (!source || !destination) {
    return { error: 'copy_file 需要 source 和 destination 参数' };
  }
  if (source === destination) {
    return { error: `源文件和目标文件相同: "${source}"` };
  }

  // 检查目标是否已存在
  try {
    await fs.access(destination, fs.constants.F_OK);
    return { error: `目标文件已存在: "${destination}"。copy_file 不会覆盖已有文件。` };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // 读取源文件
  let content;
  try {
    content = await (sessionId
      ? ctx.batchManager.readFileWithPending(source, sessionId)
      : fs.readFile(source, 'utf-8'));
  } catch (e) {
    return { error: `无法读取源文件 "${source}": ${e.message}` };
  }

  // 写入目标（通过批量事务）
  if (!sessionId) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, 'utf-8');
    return { error: null };
  }
  if (!ctx.batchManager.hasBatch(sessionId)) {
    ctx.batchManager.getOrCreateBatch(sessionId);
  }
  ctx.batchManager.scheduleSafetyCommit(sessionId);
  await ctx.batchManager.writeFileBatchAware(destination, content, sessionId);
  return { error: null };
};

// ── 文件移动 ──────────────────────────────────────────────

handlers.move_file = async (args, sessionId, ctx) => {
  const { source, destination } = args;
  if (!source || !destination) {
    return { error: 'move_file 需要 source 和 destination 参数' };
  }
  if (source === destination) {
    return { error: `源文件和目标文件相同: "${source}"` };
  }

  // 检查目标是否已存在
  try {
    await fs.access(destination, fs.constants.F_OK);
    return { error: `目标文件已存在: "${destination}"。move_file 不会覆盖已有文件。` };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // 读取源文件
  let content;
  try {
    content = await (sessionId
      ? ctx.batchManager.readFileWithPending(source, sessionId)
      : fs.readFile(source, 'utf-8'));
  } catch (e) {
    return { error: `无法读取源文件 "${source}": ${e.message}` };
  }

  // 写入目标 + 删除源（通过批量事务）
  if (!sessionId) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, 'utf-8');
    await fs.unlink(source);
    return { error: null };
  }
  if (!ctx.batchManager.hasBatch(sessionId)) {
    ctx.batchManager.getOrCreateBatch(sessionId);
  }
  ctx.batchManager.scheduleSafetyCommit(sessionId);
  await ctx.batchManager.writeFileBatchAware(destination, content, sessionId);
  // 将源文件标记为删除（写入空内容到 pending，commit 时删除）
  await ctx.batchManager.writeFileBatchAware(source, '', sessionId);
  return { error: null };
};

// ── 批量事务工具 ──────────────────────────────────────────

handlers.batch_commit = async (args, sessionId, ctx) => {
  const { name, description } = args;
  if (!sessionId || !ctx.batchManager.hasBatch(sessionId)) {
    return { error: '没有进行中的批量事务' };
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { error: 'batch_commit 需要提供 name 参数（简短提交名称）' };
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return { error: 'batch_commit 需要提供 description 参数（详细描述）' };
  }

  const { commitDir, filesMeta, sourceEntries } =
    await ctx.batchManager.prepareCommit(sessionId, name.trim(), description.trim());

  if (sourceEntries.length === 0) {
    ctx.lockManager.releaseSessionDirLocks(sessionId);
    return { error: null, message: '批量提交完成：无暂存文件，未执行任何写入', results: [], commitDir };
  }

  const commitId = ctx.batchManager.generateId();
  ctx.batchManager.storeCommitMeta(commitId, {
    sourceEntries: sourceEntries.map(([fp, info]) => ({ path: fp, tempPath: info.tempPath })),
    commitDir, description: description.trim(), sessionId,
  });

  return {
    error: null,
    message: `批量提交已受理：共 ${filesMeta.length} 个文件。渲染进程正在保存状态，稍后执行写入。`,
    results: sourceEntries.map(([fp]) => ({ path: fp, status: 'pending' })),
    commitDir, commitId,
    sourceEntries: sourceEntries.map(([fp, info]) => ({ path: fp, tempPath: info.tempPath })),
  };
};

handlers.clear_batch_cache = async (args, sessionId, ctx) => {
  if (!sessionId || !ctx.batchManager.hasBatch(sessionId)) {
    return { error: '没有进行中的批量事务' };
  }
  await ctx.batchManager.clearBatchCache(sessionId);
  setImmediate(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    ctx.lockManager.releaseSessionDirLocks(sessionId);
  });
  return { error: null, message: '暂存区已清空。所有未提交的修改已丢弃，原始文件未受影响。' };
};

// ── 回滚工具 ──────────────────────────────────────────────

handlers.list_recent_commits = async (args, sessionId, ctx) => {
  const { count, allowedDirs } = args;
  const projectRoot = path.resolve(__dirname, '..');
  const backupsDir = path.join(ctx.currentDataDir, '.backups');
  const commits = [];

  try {
    const dateDirs = await fs.readdir(backupsDir);
    const dateDirInfos = (await Promise.all(dateDirs.map(async (dateDir) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) return null;
      const datePath = path.join(backupsDir, dateDir);
      try {
        const stat = await fs.stat(datePath);
        if (!stat.isDirectory()) return null;
        const entries = await fs.readdir(datePath);
        return { dateDir, datePath, entries };
      } catch { return null; }
    }))).filter(Boolean);

    const commitCandidates = [];
    for (const { dateDir, datePath, entries } of dateDirInfos) {
      for (const entry of entries) {
        if (!entry.startsWith('commit_')) continue;
        commitCandidates.push({ dateDir, commitDir: path.join(datePath, entry) });
      }
    }

    const commitResults = await Promise.all(commitCandidates.map(async ({ dateDir, commitDir }) => {
      try {
        const commitStat = await fs.stat(commitDir);
        if (!commitStat.isDirectory()) return null;
        const metaStr = await fs.readFile(path.join(commitDir, 'commit.json'), 'utf-8');
        const meta = JSON.parse(metaStr);
        const files = (meta.files || []).map(f => {
          if (typeof f === 'string') return f.replace(/\s*\(new\)\s*$/, '');
          if (typeof f === 'object' && f.path) return f.path;
          return String(f);
        });
        return {
          dateDir, commitDir,
          description: meta.description || '(无描述)',
          timestamp: meta.timestamp || new Date(0).toISOString(),
          sessionId: meta.sessionId || null,
          files: [...new Set(files)],
          newFiles: meta.newFiles || [],
        };
      } catch { return null; }
    }));

    for (const result of commitResults) { if (result) commits.push(result); }
  } catch (e) { /* .backups 目录还不存在 */ }

  if (allowedDirs && allowedDirs.length > 0) {
    const filtered = commits.filter(c =>
      c.files.every(f => ctx.batchManager.isPathAllowed(path.join(projectRoot, f), allowedDirs))
    );
    commits.length = 0;
    commits.push(...filtered);
  }

  commits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const limit = (typeof count === 'number' && count > 0 && count < 100) ? count : 10;
  const sliced = commits.slice(0, limit);

  if (sliced.length === 0) {
    return { result: '📭 没有找到任何 commit 记录', error: null };
  }

  const lines = [
    `📋 最近 ${sliced.length} 个 commit 点（以下均为描述实施之前的原始文件备份，即描述未生效时文件的备份）：`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];
  sliced.forEach((c, i) => {
    const date = new Date(c.timestamp);
    const timeStr =
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ` +
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    lines.push(`#${i + 1}  ${timeStr}  │  ${c.description}`);
    lines.push(`    文件(${c.files.length}): ${c.files.join(', ')}`);
    lines.push(`    路径: ${c.commitDir}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
  return { result: lines.join('\n'), error: null };
};

handlers.rollback_to_commit = async (args, sessionId, ctx) => {
  const { commitDir, allowedDirs } = args;
  const projectRoot = path.resolve(__dirname, '..');

  if (sessionId && ctx.batchManager.hasBatch(sessionId)) {
    const state = ctx.batchManager.getOrCreateBatch(sessionId);
    if (state.pendingWrites.size > 0) {
      return { error: '当前 session 有未提交的暂存修改。请先 batch_commit 提交或 clear_batch_cache 清空暂存区后再执行回滚。' };
    }
  }

  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(commitDir, 'commit.json'), 'utf-8'));
  } catch (e) {
    return { error: `无法读取 commit 元数据: ${path.join(commitDir, 'commit.json')}` };
  }
  if (!meta.files || meta.files.length === 0) {
    return { error: '该 commit 没有记录任何文件，无法回滚。' };
  }

  const allFiles = [];
  const newFileSet = new Set();
  if (Array.isArray(meta.newFiles)) {
    for (const nf of meta.newFiles) {
      const cleanPath = typeof nf === 'string' ? nf.replace(/\s*\(new\)\s*$/, '') : String(nf);
      newFileSet.add(cleanPath);
    }
  }
  for (const f of meta.files) {
    if (typeof f === 'string') {
      const clean = f.replace(/\s*\(new\)\s*$/, '');
      allFiles.push(clean);
      if (f !== clean && !newFileSet.has(clean)) newFileSet.add(clean);
    } else if (typeof f === 'object' && f.path) {
      allFiles.push(f.path);
      if (f.isNew) newFileSet.add(f.path);
    } else {
      allFiles.push(String(f));
    }
  }
  const uniqueFiles = [...new Set(allFiles)];

  if (allowedDirs && allowedDirs.length > 0) {
    const denied = uniqueFiles.find(f => !ctx.batchManager.isPathAllowed(path.join(projectRoot, f), allowedDirs));
    if (denied) return { error: `commit 中包含不允许访问的文件: ${denied}。请检查角色的 MCP 配置允许目录。` };
  }

  const rollbackDirs = new Set();
  for (const relativePath of uniqueFiles) {
    const absPath = path.join(projectRoot, relativePath);
    const dir = ctx.lockManager.findTargetDir(absPath, allowedDirs);
    if (dir) rollbackDirs.add(dir);
  }
  for (const dir of rollbackDirs) {
    const result = ctx.lockManager.acquireDirLock(dir, sessionId);
    if (!result.acquired) await ctx.lockManager.waitForDirLock(dir, sessionId);
  }

  const now = new Date();
  const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  const sourceDirName = path.basename(commitDir);
  const rollbackCommitDir = path.join(ctx.currentDataDir, '.backups', dateDir, `commit_${timeStr}_rollback_to_${sourceDirName}`);
  await fs.mkdir(rollbackCommitDir, { recursive: true });

  const restoredFiles = [];
  const deletedFiles = [];
  const preRollbackFiles = [];

  for (const relativePath of uniqueFiles) {
    const originalPath = path.join(projectRoot, relativePath);
    const bakRelative = ctx.batchManager.safeRelativePath(projectRoot, originalPath);
    const bakFile = path.join(commitDir, bakRelative + '.bak');

    if (newFileSet.has(relativePath)) {
      try {
        const currentContent = await fs.readFile(originalPath, 'utf-8');
        await fs.writeFile(path.join(rollbackCommitDir, bakRelative + '.bak'), currentContent, 'utf-8');
        preRollbackFiles.push(relativePath + ' (删除前备份)');
      } catch (e) { /* 文件已不存在 */ }
      try {
        await fs.unlink(originalPath);
        deletedFiles.push(`🗑️ ${relativePath}`);
      } catch (e) {
        deletedFiles.push(e.code === 'ENOENT' ? `🗑️ ${relativePath} (已不存在，无需删除)` : `⚠️ ${relativePath}: 删除失败 (${e.message})`);
      }
    } else {
      try { await fs.access(bakFile); } catch (e) {
        restoredFiles.push(`⚠️ ${relativePath}: 备份文件缺失，跳过`);
        continue;
      }
      try {
        const currentContent = await fs.readFile(originalPath, 'utf-8');
        await fs.writeFile(path.join(rollbackCommitDir, bakRelative + '.bak'), currentContent, 'utf-8');
        preRollbackFiles.push(relativePath);
      } catch (e) { /* 原文件可能不存在 */ }
      await fs.copyFile(bakFile, originalPath);
      restoredFiles.push(`✅ ${relativePath}`);
    }
  }

  await fs.writeFile(path.join(rollbackCommitDir, 'commit.json'), JSON.stringify({
    description: `回滚至: ${sourceDirName} — ${meta.description || '(无描述)'}`,
    timestamp: now.toISOString(),
    rollbackFrom: commitDir,
    originalCommit: { description: meta.description, timestamp: meta.timestamp },
    files: preRollbackFiles,
  }, null, 2), 'utf-8');

  const resultLines = [
    `🔄 已从以下 commit 回滚：`,
    `  路径: ${commitDir}`,
    `  描述: ${meta.description || '(无描述)'}`,
    `  时间: ${meta.timestamp}`, '',
  ];
  if (restoredFiles.length > 0) { resultLines.push(`已恢复 ${restoredFiles.length} 个文件：`, ...restoredFiles); }
  if (deletedFiles.length > 0) { resultLines.push(`已删除 ${deletedFiles.length} 个新增文件：`, ...deletedFiles); }
  if (restoredFiles.length === 0 && deletedFiles.length === 0) { resultLines.push('⚠️ 没有文件被实际更改。'); }
  resultLines.push('', `📦 回滚前的当前状态已备份至：`, `  ${rollbackCommitDir}`, `  (需要撤回回滚时，可用 rollback_to_commit 恢复到该目录)`);

  if (sessionId) {
    await new Promise(resolve => setTimeout(resolve, 300));
    ctx.lockManager.releaseSessionDirLocks(sessionId);
  }
  return { error: null, message: resultLines.join('\n'), commitDir: rollbackCommitDir };
};

// ── 代码分析工具 ──────────────────────────────────────────

handlers.analyze_code = async (args, sessionId, ctx) => {
  const { path: filePath } = args;
  const content = await ctx.batchManager.readFileWithPending(filePath, sessionId);
  return ctx.codeTools.analyzeCodeWithAST(filePath, content);
};

handlers.search = async (args, sessionId, ctx) => {
  const { path: filePath, text } = args;
  const stat = await fs.stat(filePath);

  if (stat.isDirectory()) {
    const MAX_RESULTS = 200;
    const codeFiles = await ctx.codeTools.collectCodeFiles(filePath);
    if (codeFiles.length === 0) {
      return { result: `目录 "${filePath}" 中未找到任何文本文件`, error: null, truncated: false };
    }

    const nameMatches = [];
    for (const cf of codeFiles) {
      const basename = path.basename(cf);
      const nameWithoutExt = path.basename(cf, path.extname(cf));
      if (ctx.codeTools.searchMatch(nameWithoutExt, text).matched || ctx.codeTools.searchMatch(basename, text).matched) {
        nameMatches.push(path.relative(filePath, cf));
      }
    }

    const contentRefs = [];
    let truncated = false;
    let searchedCount = 0;
    const totalSlots = MAX_RESULTS - nameMatches.length;
    const CONCURRENCY = 15;

    for (let batchStart = 0; batchStart < codeFiles.length; batchStart += CONCURRENCY) {
      if (contentRefs.length >= totalSlots) { truncated = true; break; }
      const batch = codeFiles.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (cf) => {
        try {
          const content = await ctx.batchManager.readFileWithPending(cf, sessionId);
          return { file: cf, content, error: null };
        } catch (err) { return { file: cf, content: null, error: err }; }
      }));

      for (const { file: cf, content, error } of batchResults) {
        if (contentRefs.length >= totalSlots) { truncated = true; break; }
        if (error || content === null) continue;
        const lines = content.split('\n');
        searchedCount++;
        for (let idx = 0; idx < lines.length; idx++) {
          if (contentRefs.length >= totalSlots) { truncated = true; break; }
          if (ctx.codeTools.searchMatch(lines[idx], text).matched) {
            const relativePath = path.relative(filePath, cf);
            contentRefs.push({
              text: `${relativePath}:${ctx.codeTools.formatSearchResult(idx + 1, lines[idx], text)}`,
              line: lines[idx], lineNum: idx + 1,
              prevLine: idx > 0 ? lines[idx - 1] : null,
              nextLine: idx < lines.length - 1 ? lines[idx + 1] : null,
            });
          }
        }
      }
      if (truncated) break;
    }

    const totalResults = nameMatches.length + contentRefs.length;
    if (totalResults === 0) {
      return { result: `在目录 "${filePath}" 中的 ${searchedCount} 个文本文件中，未找到文本 "${text}"`, error: null, truncated: false };
    }

    const out = [];
    out.push(`# "${text}" 的搜索结果 (共${totalResults}处${truncated ? '，已截断' : ''})`);
    out.push(`搜索目录: ${filePath}`);
    out.push(`搜索文件数: ${searchedCount} / 总文本文件数: ${codeFiles.length}`, '');
    if (nameMatches.length > 0) {
      out.push(`📁 文件名匹配 (${nameMatches.length}个文件):`);
      nameMatches.forEach(r => out.push(`   📄 ${r}`));
      out.push('');
    }
    out.push(`📄 内容匹配 (${contentRefs.length}处):`);
    if (totalResults <= 5 && contentRefs.length > 0) {
      contentRefs.forEach(r => {
        out.push(`   ${r.text}`);
        if (r.prevLine !== null) out.push(`     ${r.lineNum - 1}: ${r.prevLine}`);
        out.push(`   → ${r.lineNum}: ${r.line}`);
        if (r.nextLine !== null) out.push(`     ${r.lineNum + 1}: ${r.nextLine}`);
      });
    } else {
      contentRefs.forEach(r => out.push(`   ${r.text}`));
    }
    if (truncated) {
      out.push('', `⚠️ 结果已截断：仅显示前 ${MAX_RESULTS} 条结果。如需更精确的结果，请指定具体文件路径缩小搜索范围。`);
    }
    return { result: out.join('\n'), error: null, truncated };
  } else {
    const content = await ctx.batchManager.readFileWithPending(filePath, sessionId);
    const lines = content.split('\n');
    const refs = [];
    lines.forEach((line, idx) => {
      if (ctx.codeTools.searchMatch(line, text).matched) {
        refs.push({
          text: ctx.codeTools.formatSearchResult(idx + 1, line, text),
          line, lineNum: idx + 1,
          prevLine: idx > 0 ? lines[idx - 1] : null,
          nextLine: idx < lines.length - 1 ? lines[idx + 1] : null,
        });
      }
    });
    if (refs.length === 0) return { result: `未找到文本 "${text}"`, error: null, truncated: false };
    const out = [`# "${text}" 的搜索结果 (共${refs.length}处)`, `文件: ${filePath}`, ''];
    if (refs.length <= 5) {
      refs.forEach(r => {
        out.push(r.text);
        if (r.prevLine !== null) out.push(`  ${r.lineNum - 1}: ${r.prevLine}`);
        out.push(`→ ${r.lineNum}: ${r.line}`);
        if (r.nextLine !== null) out.push(`  ${r.lineNum + 1}: ${r.nextLine}`);
      });
    } else {
      refs.forEach(r => out.push(r.text));
    }
    return { result: out.join('\n'), error: null, truncated: false };
  }
};

handlers.suggest_refactorings = async (args, sessionId, ctx) => {
  const { path: filePath } = args;
  const content = await ctx.batchManager.readFileWithPending(filePath, sessionId);
  const lines = content.split('\n');
  const suggestions = [];

  const ts = ctx.codeTools.getTS();
  if (ts) {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    suggestions.push(...ctx.codeTools.checkFunctionLength(sourceFile, content, ts));
  }

  let maxIndent = 0;
  lines.forEach(line => { const spaces = line.match(/^(\s*)/)[1].length; maxIndent = Math.max(maxIndent, spaces); });
  const approxDepth = Math.floor(maxIndent / 2);
  if (approxDepth > 6) suggestions.push(`- 嵌套层级过深（约 ${approxDepth} 层），建议提前 return 或提取子函数`);

  const importMods = lines
    .filter(l => l.trimStart().startsWith('import '))
    .map(l => { const m = l.match(/from ['"]([^'"]+)['"]/); return m ? m[1] : null; })
    .filter(Boolean);
  const seen = new Set();
  const dupes = new Set();
  importMods.forEach(m => { if (seen.has(m)) dupes.add(m); else seen.add(m); });
  if (dupes.size > 0) suggestions.push(`- 存在重复导入: ${[...dupes].join(', ')}，建议合并`);

  const analysis = ctx.codeTools.analyzeCodeWithAST(filePath, content);
  const out = [`# 重构建议: ${filePath}`, ''];
  if (suggestions.length === 0) {
    out.push('✅ 未发现明显重构问题');
  } else {
    out.push('## 改进建议');
    suggestions.forEach(s => out.push(s));
  }
  out.push('', '## 代码概览', analysis.result || '（分析不可用）');
  return { result: out.join('\n'), error: null };
};

handlers.modify_code = async (args, sessionId, ctx) => {
  const { path: filePath, old_string: oldString, new_string: newString } = args;
  if (sessionId && !ctx.batchManager.hasBatch(sessionId)) {
    ctx.batchManager.getOrCreateBatch(sessionId);
  }
  ctx.batchManager.scheduleSafetyCommit(sessionId);

  const content = await ctx.batchManager.readFileWithPending(filePath, sessionId);
  if (!content.includes(oldString)) {
    const threshold = Math.max(2, Math.floor(oldString.length * 0.15));
    const similar = ctx.codeTools.findSimilarLines(content, oldString, 5, threshold + oldString.length);
    let hint = `未找到匹配的字符串。请确认 old_string 与文件内容完全一致（包括空格、缩进和换行符）。`;
    if (similar.length > 0) {
      hint += '\n\n🔍 发现以下近似匹配，你可能需要检查：';
      similar.forEach((s, i) => {
        const preview = s.content.length > 120 ? s.content.slice(0, 120) + '…' : s.content;
        hint += `\n  #${i + 1} 第${s.line}行 (相差${s.distance}字符):\n    \`${preview}\``;
      });
    }
    return { error: hint };
  }

  const lineOfIdx = (charIdx) => (content.slice(0, charIdx).match(/\n/g) || []).length + 1;
  const firstIdx = content.indexOf(oldString);
  const secondIdx = content.indexOf(oldString, firstIdx + 1);
  if (secondIdx !== -1) {
    const positions = [];
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchFrom);
      if (idx === -1) break;
      positions.push(`第 ${lineOfIdx(idx)} 行`);
      searchFrom = idx + 1;
    }
    return { error: `old_string 在文件中有 ${positions.length} 处匹配（${positions.join('；')}），无法确定目标位置。请在 old_string 中包含更多周围代码作为上下文，使 old_string 在文件中唯一匹配。` };
  }

  const matchIndex = content.indexOf(oldString);
  const prefix = content.slice(0, matchIndex);
  const startLine = (prefix.match(/\n/g) || []).length + 1;
  const endLine = startLine + (oldString.match(/\n/g) || []).length;
  const newContent = content.replace(oldString, () => newString);
  await ctx.batchManager.writeFileBatchAware(filePath, newContent, sessionId);
  return { error: null, oldString, newString, startLine, endLine };
};

// ── Python 工具 ────────────────────────────────────────────

handlers.run_python = async (args, sessionId, ctx) => {
  const { code, env_name, timeout } = args;
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return { error: 'run_python 缺少必要参数: code（要执行的 Python 源代码）。' };
  }
  const result = await ctx.pythonSandbox.executePython({
    code,
    envName: env_name || null,
    timeout: typeof timeout === 'number' ? timeout : 30,
    dataDir: ctx.currentDataDir,
  });
  return { error: null, ...result };
};

handlers.list_conda_envs = async (args, sessionId, ctx) => {
  try {
    const envs = await ctx.pythonSandbox.listCondaEnvs();
    return { error: null, envs };
  } catch (err) {
    return { error: err.message, envs: [] };
  }
};

// ── Web 工具 ───────────────────────────────────────────────

handlers.fetch_url = async (args, sessionId, ctx) => {
  const { url, timeout, max_size, strip_html } = args;
  if (!url || typeof url !== 'string') {
    return { error: 'fetch_url 缺少必要参数: url（要访问的 http/https 地址）。' };
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return { error: `无效的 URL 格式: "${url}"。请提供合法的 http/https 地址。` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { error: `不支持的协议 "${parsedUrl.protocol}"。fetch_url 仅支持 http:// 和 https://。` };
  }
  if (isPrivateIP(parsedUrl.hostname)) {
    return { error: `安全限制：禁止访问内网地址 "${parsedUrl.hostname}"。如需访问本地文件请使用 read_file 工具。` };
  }

  const safeTimeout = typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60) * 1000 : 30000;
  const safeMaxSize = typeof max_size === 'number' && max_size > 0 ? Math.min(max_size, 5_000_000) : 500000;
  const shouldStripHtml = strip_html !== false;
  const httpModule = parsedUrl.protocol === 'https:' ? https : http;

  const result = await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { req.destroy(); safeResolve({ error: `请求超时（${Math.round(safeTimeout / 1000)}s），已中断。` }); }, safeTimeout);

    const req = httpModule.get(parsedUrl, {
      headers: { 'User-Agent': 'Bamboo/1.0 (MCP fetch_url tool)', 'Accept': 'text/*, application/json, application/xml, */*' },
    }, (res) => {
      const redirectCodes = [301, 302, 303, 307, 308];
      let redirectCount = 0;

      const handleResponse = (response) => {
        if (redirectCodes.includes(response.statusCode) && response.headers.location) {
          redirectCount++;
          if (redirectCount > 5) { safeResolve({ error: '重定向次数过多（超过 5 次），已中止。' }); return; }
          let redirectUrl = response.headers.location;
          try { redirectUrl = new URL(redirectUrl, url).href; } catch {
            safeResolve({ error: `无效的重定向地址: "${response.headers.location}"` }); return;
          }
          const redirectProto = redirectUrl.startsWith('https://') ? https : http;
          redirectProto.get(redirectUrl, { timeout: safeTimeout }).on('response', handleResponse).on('error', (err) => {
            safeResolve({ error: `重定向请求失败: ${err.message}` });
          });
          return;
        }

        const chunks = [];
        let totalSize = 0;
        let exceeded = false;
        response.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > safeMaxSize) { exceeded = true; response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (exceeded) {
            const partial = Buffer.concat(chunks).toString('utf-8');
            safeResolve({ error: null, content: (shouldStripHtml ? stripHtmlContent(partial) : partial) + `\n\n⚠️ 响应已截断（超过 ${Math.round(safeMaxSize / 1000)}KB 限制）`, truncated: true, statusCode: response.statusCode });
            return;
          }
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const body = shouldStripHtml ? stripHtmlContent(rawBody) : rawBody;
          safeResolve({ error: null, content: body, truncated: false, statusCode: response.statusCode });
        });
        response.on('error', (err) => { safeResolve({ error: `响应读取失败: ${err.message}` }); });
      };
      handleResponse(res);
    });
    req.on('error', (err) => { safeResolve({ error: `请求失败: ${err.message}` }); });
  });

  return result;
};

// ── 通用 HTTP 执行器（用户工具）──────────────────────────

handlers.__generic_http = async (args, sessionId, ctx) => {
  const { url, method, headers, body, timeout, max_size } = args;
  if (!url || typeof url !== 'string') {
    return { error: '缺少必要参数: url' };
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return { error: `无效的 URL 格式: "${url}"` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { error: `不支持的协议 "${parsedUrl.protocol}"` };
  }
  if (isPrivateIP(parsedUrl.hostname)) {
    return { error: `安全限制：禁止访问内网地址 "${parsedUrl.hostname}"` };
  }

  const safeTimeout = (typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60) : 30) * 1000;
  const safeMaxSize = typeof max_size === 'number' && max_size > 0 ? Math.min(max_size, 5_000_000) : 500000;
  const httpModule = parsedUrl.protocol === 'https:' ? https : http;

  const result = await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { req.destroy(); safeResolve({ error: `请求超时（${Math.round(safeTimeout / 1000)}s）` }); }, safeTimeout);

    const options = {
      method: (method || 'GET').toUpperCase(),
      headers: {
        'User-Agent': 'Bamboo/1.0 (user tool)',
        'Accept': 'text/*, application/json, */*',
        ...(headers || {}),
      },
    };

    const req = httpModule.request(parsedUrl, options, (res) => {
      const chunks = [];
      let totalSize = 0;
      let exceeded = false;
      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > safeMaxSize) { exceeded = true; res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        safeResolve({
          error: null,
          content: exceeded ? rawBody + `\n\n⚠️ 响应已截断（超过 ${Math.round(safeMaxSize / 1000)}KB 限制）` : rawBody,
          statusCode: res.statusCode,
          truncated: exceeded,
        });
      });
      res.on('error', (err) => safeResolve({ error: `响应读取失败: ${err.message}` }));
    });

    if (body && options.method !== 'GET') {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.on('error', (err) => safeResolve({ error: `请求失败: ${err.message}` }));
    req.end();
  });

  return result;
};

// ── 通用 Shell 执行器（用户工具）──────────────────────────

handlers.__generic_shell = async (args, sessionId, ctx) => {
  const { command, allowedCommands, timeout } = args;
  if (!command || typeof command !== 'string') {
    return { error: '缺少必要参数: command' };
  }

  // 提取命令名（第一个词）
  const cmdName = command.trim().split(/\s+/)[0];
  const allowed = allowedCommands || [];

  // 如果有白名单，检查命令是否在白名单中
  if (allowed.length > 0 && !allowed.includes(cmdName)) {
    return { error: `安全限制：命令 "${cmdName}" 不在允许列表中。允许的命令: ${allowed.join(', ')}` };
  }

  const safeTimeout = (typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 30) : 10) * 1000;

  try {
    const { execSync } = require('child_process');
    const output = execSync(command, {
      timeout: safeTimeout,
      maxBuffer: 500 * 1024, // 500KB
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    return { error: null, stdout: output, stderr: '' };
  } catch (err) {
    return {
      error: null,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      exitCode: err.status || 1,
    };
  }
};

// ── 通用 Python 执行器（用户工具）──────────────────────────

handlers.__generic_python = async (args, sessionId, ctx) => {
  const { code, env_name, timeout } = args;
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return { error: '缺少必要参数: code' };
  }
  try {
    const result = await ctx.pythonSandbox.executePython({
      code,
      envName: env_name || null,
      timeout: typeof timeout === 'number' ? Math.min(timeout, 60) : 30,
      dataDir: ctx.currentDataDir,
    });
    return { error: null, ...result };
  } catch (err) {
    return { error: err.message };
  }
};

// ═══════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════

/**
 * 执行工具调用
 * @param {string} toolName - 工具名称
 * @param {object} args - 工具参数
 * @param {string|null} sessionId - 会话 ID
 * @param {object} ctx - 上下文（batchManager, lockManager, codeTools, pythonSandbox, currentDataDir）
 * @returns {Promise<any>} 执行结果
 */
async function execute(toolName, args, sessionId, ctx) {
  const handler = handlers[toolName];
  if (!handler) {
    return { error: `未知工具: ${toolName}` };
  }
  try {
    return await handler(args, sessionId, ctx);
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 返回所有已注册的工具名称列表
 */
function getToolNames() {
  return Object.keys(handlers);
}

module.exports = { execute, getToolNames };