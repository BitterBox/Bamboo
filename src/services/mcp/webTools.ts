// src/services/mcp/webTools.ts
// Web 工具执行器 — 权限校验 + IPC 调用
// 工具定义已外置到 /tools/builtin/*.json，此处仅保留执行逻辑

import type { ToolDefinition } from '../../types';
import type { MCPRegistry } from './registry';
import { getEffectiveMCPConfig } from './permissionAware';
import { registerBuiltinExecutor } from './manifestLoader';

// ═══════════════════════════════════════════════════════════
// Web 工具执行器
// ═══════════════════════════════════════════════════════════

async function executeFetchUrl(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { url, timeout, max_size, strip_html } = args as {
    url: string;
    timeout?: number;
    max_size?: number;
    strip_html?: boolean;
  };

  if (!url || typeof url !== 'string') {
    throw new Error('fetch_url 缺少必要参数: url（要访问的 http/https 地址）。请提供 url 参数后重试。');
  }

  const config = getEffectiveMCPConfig(sessionId);
  if (!config.webToolEnabled) {
    throw new Error('Web 工具已在 MCP 设置中禁用。请在智能体配置中开启 "Web 工具" 开关。');
  }
  if (!config.allowRead) {
    throw new Error('读取权限已在 MCP 设置中禁用。Web 工具需要读取权限。');
  }

  if (!window.electronAPI) {
    throw new Error('Web 工具仅在 Electron 桌面端版本中可用。');
  }

  const safeTimeout = typeof timeout === 'number' && timeout > 0
    ? Math.min(timeout, 60)
    : 30;
  const safeMaxSize = typeof max_size === 'number' && max_size > 0
    ? Math.min(max_size, 5_000_000)
    : 500_000;
  const safeStripHtml = strip_html !== false;

  const result = await window.electronAPI.toolExecute('fetch_url', {
    url,
    timeout: safeTimeout,
    max_size: safeMaxSize,
    strip_html: safeStripHtml,
  }, sessionId);
  if (result.error) throw new Error(result.error);

  const parts: string[] = [];
  parts.push(`HTTP ${result.statusCode} — ${result.contentType || 'unknown'}`);
  if (result.truncated) {
    parts.push(`⚠️ 响应已截断：实际大小 ${result.actualSize ?? '未知'} 字节，已超过 ${safeMaxSize} 字节上限。`);
  }
  parts.push('');
  parts.push(result.content ?? '（空响应）');
  return parts.join('\n');
}

// ── 注册到清单加载器 ──
registerBuiltinExecutor('fetch_url', executeFetchUrl);

// ── 向后兼容 ──
export function registerWebTools(_registry: MCPRegistry) {
  // 工具定义已外置到 /tools/builtin/*.json
  // 执行器已通过 registerBuiltinExecutor() 注册
}