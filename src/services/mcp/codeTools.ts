// src/services/mcp/codeTools.ts
// 代码工具执行器 — 权限校验 + IPC 调用
// 工具定义已外置到 /tools/builtin/*.json，此处仅保留执行逻辑

import type { ToolDefinition } from '../../types';
import type { MCPRegistry } from './registry';
import { getEffectiveMCPConfig } from './permissionAware';
import { registerBuiltinExecutor } from './manifestLoader';

// ═══════════════════════════════════════════════════════════
// 代码工具执行器
// ═══════════════════════════════════════════════════════════

async function executeAnalyzeCode(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path } = args as { path: string };
  if (!window.electronAPI) throw new Error('代码工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('analyze_code', { path }, sessionId);
  if (result.error) throw new Error(result.error);
  return result.result ?? '';
}

async function executeSearch(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path, text } = args as { path: string; text: string };
  const missing: string[] = [];
  if (!path) missing.push('path（文件或目录的绝对路径）');
  if (!text) missing.push('text（要搜索的文本）');
  if (missing.length > 0) throw new Error(`search 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  if (!window.electronAPI) throw new Error('代码工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('search', { path, text }, sessionId);
  if (result.error) throw new Error(result.error);
  return result.result ?? '';
}

async function executeSuggestRefactorings(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path } = args as { path: string };
  if (!window.electronAPI) throw new Error('代码工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('suggest_refactorings', { path }, sessionId);
  if (result.error) throw new Error(result.error);
  return result.result ?? '';
}

async function executeModifyCode(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { path, old_string, new_string } = args as { path: string; old_string: string; new_string: string };

  const missing: string[] = [];
  if (typeof path !== 'string' || !path) missing.push('path（要修改的文件绝对路径）');
  if (typeof old_string !== 'string') missing.push('old_string（要查找的精确字符串）');
  if (typeof new_string !== 'string') missing.push('new_string（替换后的新字符串）');
  if (missing.length > 0) {
    throw new Error(`modify_code 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  }

  if (!window.electronAPI) throw new Error('代码工具仅在 Electron 桌面端版本中可用');
  const result = await window.electronAPI.toolExecute('modify_code', { path, old_string, new_string }, sessionId);
  if (result.error) throw new Error(result.error);

  const oldLines = old_string.split('\n');
  const newLines = new_string.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);
  const verifyOffset = Math.max(1, (result.startLine ?? 1) - 3);
  const verifyLimit = maxLen + 6;

  const lines: string[] = [];
  lines.push(`📝 修改已暂存至批量事务缓冲区：${path}`);
  if (result.startLine !== undefined && result.endLine !== undefined) {
    const lineRange = result.startLine === result.endLine
      ? `第 ${result.startLine} 行`
      : `第 ${result.startLine}–${result.endLine} 行`;
    lines.push(`📍 修改位置：${lineRange}`);
    lines.push(`   （可用 read_file offset=${verifyOffset} limit=${verifyLimit} 定位验证）`);
  }
  lines.push('', '📝 改动详情：', '');

  if (oldLines.length <= 1 && newLines.length <= 1) {
    lines.push(`  ❌ 删除: \`${old_string}\``);
    lines.push(`  ✅ 新增: \`${new_string}\``);
  } else if (oldLines.length === newLines.length) {
    lines.push('  ┌─ ❌ 旧内容 ─────────────────────────────');
    for (let i = 0; i < oldLines.length; i++) {
      const changed = oldLines[i] !== newLines[i];
      lines.push(`  ${changed ? '✕  ' : '   '}${oldLines[i]}`);
    }
    lines.push('  ├─ ✅ 新内容 ─────────────────────────────');
    for (let i = 0; i < newLines.length; i++) {
      const changed = oldLines[i] !== newLines[i];
      lines.push(`  ${changed ? '✚  ' : '   '}${newLines[i]}`);
    }
    lines.push('  └──────────────────────────────────────────');
  } else {
    lines.push('  ┌─ ❌ 被替换的代码 ───────────────────────');
    oldLines.forEach(l => lines.push(`  │ ${l}`));
    lines.push('  └──────────────────────────────────────────');
    lines.push('  ┌─ ✅ 替换后的代码 ───────────────────────');
    newLines.forEach(l => lines.push(`  │ ${l}`));
    lines.push('  └──────────────────────────────────────────');
  }

  lines.push('');
  lines.push('⚠️ 此修改暂未写入原文件。请及时调用 batch_commit 提交所有暂存修改使其原子生效。');
  return lines.join('\n');
}

// ── 注册到清单加载器 ──
registerBuiltinExecutor('analyze_code', executeAnalyzeCode);
registerBuiltinExecutor('search', executeSearch);
registerBuiltinExecutor('suggest_refactorings', executeSuggestRefactorings);
registerBuiltinExecutor('modify_code', executeModifyCode);

// ── 向后兼容 ──
export function registerCodeTools(_registry: MCPRegistry) {
  // 工具定义已外置到 /tools/builtin/*.json
  // 执行器已通过 registerBuiltinExecutor() 注册
}
