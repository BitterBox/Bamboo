// src/services/mcp/fileTools.ts
// 文件工具执行器 — 权限校验 + IPC 调用
// 工具定义已外置到 /tools/builtin/*.json，此处仅保留执行逻辑
import type { ToolDefinition } from '../../types';
import type { MCPRegistry } from './registry';
import { getEffectiveMCPConfig } from './permissionAware';
import { registerBuiltinExecutor } from './manifestLoader';

/**
 * 安全词数统计（一次遍历，不创建大数组，防止超长字符串卡死）
 *
 * 工作原理：
 * 1. 如果文本较短（≤ SAFE_CHAR_LIMIT），一次遍历统计英文单词和 CJK 字符
 * 2. 如果超长，只统计前 SAFE_CHAR_LIMIT 个字符，避免扫描整个字符串
 */
function countWords(text: string): number {
  const SAFE_CHAR_LIMIT = 200_000; // 单次处理上限（20 万字符），超长则只计前段
  const limit = Math.min(text.length, SAFE_CHAR_LIMIT);

  let count = 0;
  let inWord = false;

  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);

    // 英文单词：连续字母数字下划线（a-z, A-Z, 0-9, _）
    if ((code >= 0x30 && code <= 0x39) ||   // 0-9
        (code >= 0x41 && code <= 0x5A) ||   // A-Z
        (code >= 0x61 && code <= 0x7A) ||   // a-z
        code === 0x5F) {                    // _
      if (!inWord) { count++; inWord = true; }
    } else {
      inWord = false;
      // CJK 字符（汉字、日文假名、韩文）：每个算 1 词
      if ((code >= 0x4E00 && code <= 0x9FFF) ||   // 中文
          (code >= 0x3040 && code <= 0x309F) ||   // 日文平假名
          (code >= 0x30A0 && code <= 0x30FF) ||   // 日文片假名
          (code >= 0xAC00 && code <= 0xD7AF)) {   // 韩文
        count++;
      }
    }
  }

  return count;
}

/** 截断文本到指定词数，返回截断后的文本、实际词数和是否截断 */
function truncateByWords(text: string, maxWords: number): { text: string; words: number; truncated: boolean } {
  const SAFE_CHAR_LIMIT = 200_000; // 字符安全阈值

  // ── 如果文本超长，先做字符级截断，避免全量处理卡死 ──
  if (text.length > SAFE_CHAR_LIMIT) {
    const truncatedText = text.slice(0, SAFE_CHAR_LIMIT);
    // 截断后递归调用，检查是否需要词数截断
    return truncateByWords(truncatedText, maxWords);
  }

  // ── 先整体统计，没超限直接返回 ──
  const totalWords = countWords(text);
  if (totalWords <= maxWords) {
    return { text, words: totalWords, truncated: false };
  }

  // ── 超过词数上限，按比例估算截断位置，避免逐词 exec 循环 ──
  // 词密度 = 总词数 / 总字符数，截断位置 ≈ maxWords / 词密度
  const estimatedPos = Math.floor((maxWords / totalWords) * text.length);
  // 在估算位置附近找最近的换行或空格做整齐截断
  let cutPos = Math.min(estimatedPos, text.length);
  // 向前搜索最近的换行符
  while (cutPos > 0 && text[cutPos] !== '\n' && cutPos > estimatedPos - 100) cutPos--;
  if (cutPos === 0 || cutPos <= estimatedPos - 100) {
    // 没找到换行，按空格截断
    cutPos = estimatedPos;
    while (cutPos > 0 && text[cutPos] !== ' ' && cutPos > estimatedPos - 50) cutPos--;
    if (cutPos === 0 || cutPos <= estimatedPos - 50) {
      cutPos = estimatedPos; // 实在找不到，直接按位置截断
    }
  }

  const result = text.slice(0, cutPos);
  // 重新统计截断后的词数
  const finalWords = countWords(result);
  return { text: result, words: finalWords, truncated: true };
}

/** 检查路径是否在允许的目录白名单内 */
function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error(`path 参数无效: 需要提供有效的文件绝对路径字符串，但收到了 "${targetPath}"（${typeof targetPath}）。`);
  }
  if (allowedDirs.length === 0) return false;
  const normalized = targetPath.replace(/\\/g, '/');
  return allowedDirs.some(dir => {
    const base = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return normalized === base.slice(0, -1) || normalized.startsWith(base);
  });
}

// ═══════════════════════════════════════════════════════════
// 文件工具执行器
// ═══════════════════════════════════════════════════════════

async function executeReadFile(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path, offset, limit } = args as { path: string; offset?: number; limit?: number };
  if (!path) throw new Error('read_file 缺少必要参数: path（要读取的文件绝对路径）。请提供 path 参数后重试。');
  if (!window.electronAPI) throw new Error('文件工具仅在 Electron 桌面端版本中可用');

  const MAX_LINES = 2000;
  const DEFAULT_LINES = 75;
  const safeLimit = (typeof limit === 'number' && limit > 0) ? Math.min(limit, MAX_LINES) : DEFAULT_LINES;

  const result = await window.electronAPI.toolExecute('read_file', { path, offset, limit: safeLimit }, sessionId);
  if (result.error) throw new Error(result.error);

  let output = result.content ?? '';
  const MAX_WORDS = 50000;
  const { text: truncatedText, words: actualWords, truncated } = truncateByWords(output, MAX_WORDS);
  if (truncated) {
    output = truncatedText + `\n\n⚠️ 输出已截断：实际约 ${actualWords} 词，已达 ${MAX_WORDS} 词上限。如需查看更多内容，请使用 search 工具搜索特定内容，或使用 offset/limit 分页读取。`;
  }
  if (result.totalLines !== undefined) {
    const rangeInfo = `（第 ${result.startLine}–${result.endLine} 行 / 共 ${result.totalLines} 行）`;
    output = rangeInfo + '\n' + output;
  }
  return output;
}

async function executeWriteFile(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path, content } = args as { path: string; content: string };
  const missing: string[] = [];
  if (!path) missing.push('path（要创建的文件绝对路径）');
  if (typeof content !== 'string') missing.push('content（文件内容）');
  if (missing.length > 0) throw new Error(`write_file 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  if (!window.electronAPI) throw new Error('文件工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('write_file', { path, content }, sessionId);
  if (result.error) throw new Error(result.error);
  return `新文件创建成功: ${path}`;
}

async function executeListDirectory(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path } = args as { path: string };
  if (!path) throw new Error('list_directory 缺少必要参数: path（要列出内容的目录绝对路径）。请提供 path 参数后重试。');
  if (!window.electronAPI) throw new Error('文件工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('list_directory', { path }, sessionId);
  if (result.error) throw new Error(result.error);
  const entries = result.entries ?? [];
  const lines = entries.map(e => `${e.type === 'directory' ? '[DIR]' : '[FILE]'} ${e.name}`);
  return lines.length > 0 ? lines.join('\n') : '（空目录）';
}

async function executeBatchCommit(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { name, description } = args as { name: string; description: string };
  if (!window.electronAPI) throw new Error('批量事务仅在 Electron 桌面端版本中可用');

  const result = await window.electronAPI.toolExecute('batch_commit', { name, description }, sessionId);
  if (result.error) throw new Error(result.error);

  if (!result.commitId || !result.sourceEntries || result.sourceEntries.length === 0) {
    return result.message ?? '批量提交完成';
  }

  const { flushAndSave, collectSessionSnapshot, checkStalledSessions } = await import('../../hooks/sessionRecovery');
  await flushAndSave();
  const sessionsSnapshot = collectSessionSnapshot(sessionId);

  const finalResult = await window.electronAPI.mcpFinalizeCommit(result.commitId, sessionsSnapshot);
  checkStalledSessions(sessionsSnapshot);

  setTimeout(() => {
    window.electronAPI?.mcpClearRecoveryList(result.commitId).catch(() => {});
  }, 2000);

  if (finalResult.error) throw new Error(finalResult.error);
  return finalResult.message ?? '批量提交完成';
}

async function executeClearBatchCache(_args: unknown, _agentId?: string | null, sessionId?: string | null) {
  if (!window.electronAPI) throw new Error('批量事务仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('clear_batch_cache', {}, sessionId);
  if (result.error) throw new Error(result.error);
  return result.message ?? '暂存区已清空';
}

async function executeListRecentCommits(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { count } = args as { count?: number };
  const { allowedDirs } = getEffectiveMCPConfig(sessionId);
  if (!window.electronAPI) throw new Error('回滚功能仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('list_recent_commits', { count, allowedDirs }, sessionId);
  if (result.error) throw new Error(result.error);
  return result.result ?? '';
}

async function executeRollbackToCommit(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { commitDir } = args as { commitDir: string };
  const { allowedDirs } = getEffectiveMCPConfig(sessionId);
  if (!window.electronAPI) throw new Error('回滚功能仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('rollback_to_commit', { commitDir, allowedDirs }, sessionId);
  if (result.error) throw new Error(result.error);
  return result.message ?? '回滚完成';
}

async function executeCopyFile(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { source, destination } = args as { source: string; destination: string };
  const missing: string[] = [];
  if (!source) missing.push('source（源文件绝对路径）');
  if (!destination) missing.push('destination（目标文件绝对路径）');
  if (missing.length > 0) throw new Error(`copy_file 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  if (!window.electronAPI) throw new Error('文件工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('copy_file', { source, destination }, sessionId);
  if (result.error) throw new Error(result.error);
  return `文件已复制: ${source} → ${destination}`;
}

async function executeMoveFile(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { source, destination } = args as { source: string; destination: string };
  const missing: string[] = [];
  if (!source) missing.push('source（源文件绝对路径）');
  if (!destination) missing.push('destination（目标文件绝对路径）');
  if (missing.length > 0) throw new Error(`move_file 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  if (!window.electronAPI) throw new Error('文件工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('move_file', { source, destination }, sessionId);
  if (result.error) throw new Error(result.error);
  return `文件已移动: ${source} → ${destination}`;
}

// ── 注册到清单加载器 ──
registerBuiltinExecutor('read_file', executeReadFile);
registerBuiltinExecutor('write_file', executeWriteFile);
registerBuiltinExecutor('list_directory', executeListDirectory);
registerBuiltinExecutor('copy_file', executeCopyFile);
registerBuiltinExecutor('move_file', executeMoveFile);
registerBuiltinExecutor('batch_commit', executeBatchCommit);
registerBuiltinExecutor('clear_batch_cache', executeClearBatchCache);
registerBuiltinExecutor('list_recent_commits', executeListRecentCommits);
registerBuiltinExecutor('rollback_to_commit', executeRollbackToCommit);

// ── 向后兼容：旧版 registerFileTools 已委托给 manifestLoader ──
export function registerFileTools(_registry: MCPRegistry) {
  // 工具定义已外置到 /tools/builtin/*.json
  // 执行器已通过 registerBuiltinExecutor() 注册
  // 此函数保留仅为向后兼容，新代码请使用 loadAllTools()
}
