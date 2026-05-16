// src/services/mcp/pythonTools.ts
// Python 工具执行器 — 权限校验 + IPC 调用
// 工具定义已外置到 /tools/builtin/*.json，此处仅保留执行逻辑

import type { ToolDefinition } from '../../types';
import type { MCPRegistry } from './registry';
import { getEffectiveMCPConfig } from './permissionAware';
import { registerBuiltinExecutor } from './manifestLoader';

// ═══════════════════════════════════════════════════════════
// Python 工具执行器
// ═══════════════════════════════════════════════════════════

async function executeRunPython(args: unknown, _agentId?: string | null, sessionId?: string | null) {
  const { code, env_name, timeout } = args as {
    code: string;
    env_name?: string;
    timeout?: number;
  };

  const missing: string[] = [];
  if (!code) missing.push('code（要执行的 Python 源代码）');
  if (missing.length > 0) {
    throw new Error(`run_python 缺少必要参数: ${missing.join('、')}。请提供完整参数后重试。`);
  }

  const config = getEffectiveMCPConfig(sessionId);
  if (!config.pythonToolEnabled) {
    throw new Error('Python 执行功能已在 MCP 设置中禁用。请在智能体配置中开启 "Python 工具" 开关。');
  }

  if (!window.electronAPI) {
    throw new Error('Python 工具仅在 Electron 桌面端版本中可用。');
  }

  const result = await window.electronAPI.toolExecute('run_python', {
    code,
    env_name: env_name || config.condaEnv || null,
    timeout: timeout ?? 30,
  }, sessionId);

  const lines: string[] = [];
  const resolvedEnvName = env_name || config.condaEnv || null;
  const envLabel = result.envType === 'conda' ? `Conda 环境: ${resolvedEnvName}` : '系统默认 Python';
  const statusIcon = result.exitCode === 0 ? '✅' : '❌';

  lines.push(`${statusIcon} Python 执行完毕（退出码: ${result.exitCode}）`);
  lines.push(`  环境: ${envLabel}`);
  lines.push(`  解释器: ${result.pythonPath}`);
  lines.push(`  用时: ${result.elapsed}`);
  lines.push('');

  if (result.stdout) {
    const truncNote = result.stdoutTruncated ? ' （输出过长已截断至前 50000 词）' : '';
    lines.push(`━━━ stdout${truncNote} ━━━`);
    lines.push(result.stdout);
  } else {
    lines.push('━━━ stdout ━━━');
    lines.push('（无输出）');
  }

  if (result.stderr) {
    lines.push('');
    lines.push('━━━ stderr ━━━');
    lines.push(result.stderr);
  }

  if (result.exitCode !== 0) {
    lines.push('');
    if (result.stderr) {
      const stderrLines = result.stderr.split('\n');
      const lastLine = stderrLines[stderrLines.length - 1].trim();
      if (lastLine) lines.push(`💡 错误摘要: ${lastLine}`);
    }
    lines.push('💡 提示: 请检查代码中的语法错误、未定义变量或导入不存在的模块。');
  }

  return lines.join('\n');
}

async function executeListCondaEnvs(_args: unknown, _agentId?: string | null, _sessionId?: string | null) {
  if (!window.electronAPI) {
    throw new Error('Python 工具仅在 Electron 桌面端版本中可用。');
  }
  const result = await window.electronAPI.mcpListCondaEnvs();
  if (result.error) throw new Error(result.error);
  const envs = result.envs ?? [];
  return envs.length > 0 ? `可用的 Conda 环境:\n${envs.map(e => `  - ${e}`).join('\n')}` : '未找到任何 Conda 环境';
}

// ── 注册到清单加载器 ──
registerBuiltinExecutor('run_python', executeRunPython);
registerBuiltinExecutor('list_conda_envs', executeListCondaEnvs);

// ── 向后兼容 ──
export function registerPythonTools(_registry: MCPRegistry) {
  // 工具定义已外置到 /tools/builtin/*.json
  // 执行器已通过 registerBuiltinExecutor() 注册
}
