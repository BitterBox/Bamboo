// src/services/mcp/manifestLoader.ts
// 工具清单加载器：从 JSON 文件加载工具定义，注册到 MCPRegistry
//
// 内置工具：通过 Vite import.meta.glob 在构建时内联
// 用户工具：通过 IPC 在运行时从 {dataDir}/tools/user/ 加载（待实现）

import type { ToolManifest } from './manifestTypes';
import { manifestToToolDefinition } from './manifestTypes';
import type { MCPRegistry } from './registry';
import type { ToolExecutor } from './types';
import { getEffectiveMCPConfig } from './permissionAware';
import { validateManifest } from './manifestValidator';

// ═══════════════════════════════════════════════════════════
// Vite import.meta.glob — 构建时将 tools/builtin/*.json 内联
// ═══════════════════════════════════════════════════════════

const builtinModules = import.meta.glob<ToolManifest>(
  '/tools/builtin/*.json',
  { import: 'default' }
);

// ═══════════════════════════════════════════════════════════
// 内置执行器映射（由各工具模块注册）
// ═══════════════════════════════════════════════════════════

const builtinExecutors = new Map<string, ToolExecutor['execute']>();

/**
 * 注册内置执行器（由 fileTools.ts / codeTools.ts 等模块调用）
 */
export function registerBuiltinExecutor(
  name: string,
  execute: ToolExecutor['execute']
) {
  builtinExecutors.set(name, execute);
}

// ═══════════════════════════════════════════════════════════
// 工具元数据映射（由 loadAllTools 填充，供 permissionAware 查询）
// ═══════════════════════════════════════════════════════════

interface ToolMeta {
  category: string;
  read: boolean;
  write: boolean;
}

const toolMetaMap = new Map<string, ToolMeta>();

/**
 * 查询工具的元数据（类别 + 读写标记）
 * 用于 permissionAware 按 MCP 配置过滤
 */
export function getToolMeta(name: string): ToolMeta | undefined {
  return toolMetaMap.get(name);
}

// ═══════════════════════════════════════════════════════════
// 权限校验辅助
// ═══════════════════════════════════════════════════════════

function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (allowedDirs.length === 0) return false;
  const normalized = targetPath.replace(/\\/g, '/');
  return allowedDirs.some(dir => {
    const base = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return normalized === base.slice(0, -1) || normalized.startsWith(base);
  });
}

/**
 * 根据清单的 permissions 声明，创建权限校验包装函数
 */
function wrapWithPermissions(
  manifest: ToolManifest,
  innerExecute: ToolExecutor['execute']
): ToolExecutor['execute'] {
  return async (args, agentId, sessionId) => {
    const config = getEffectiveMCPConfig(sessionId);
    const perms = manifest.permissions;

    // 检查 allowRead
    if (perms.includes('allowRead') && !config.allowRead) {
      throw new Error('读取权限已在 MCP 设置中禁用');
    }

    // 检查 allowWrite
    if (perms.includes('allowWrite') && !config.allowWrite) {
      throw new Error('写入权限已在 MCP 设置中禁用');
    }

    // 检查 pythonToolEnabled
    if (perms.includes('pythonToolEnabled') && !config.pythonToolEnabled) {
      throw new Error('Python 工具已在 MCP 设置中禁用');
    }

    // 检查 webToolEnabled
    if (perms.includes('webToolEnabled') && !config.webToolEnabled) {
      throw new Error('Web 工具已在 MCP 设置中禁用');
    }

    // 检查 pathInAllowedDirs（对 path / source / destination 参数做目录白名单校验）
    if (perms.includes('pathInAllowedDirs')) {
      for (const key of ['path', 'source', 'destination']) {
        const val = (args as Record<string, unknown>)?.[key];
        if (typeof val === 'string' && !isPathAllowed(val, config.allowedDirs)) {
          throw new Error(`拒绝访问: "${val}" 不在允许的目录列表中`);
        }
      }
    }

    // 检查 commitDir 参数（回滚工具专用）
    if (perms.includes('commitDirInAllowedDirs')) {
      const commitDirArg = (args as Record<string, unknown>)?.commitDir;
      // commitDir 的路径校验在主进程的 rollback handler 中完成
      // 这里只做基本检查
      if (!commitDirArg || typeof commitDirArg !== 'string') {
        throw new Error('commitDir 参数无效');
      }
    }

    return innerExecute(args, agentId, sessionId);
  };
}

// ═══════════════════════════════════════════════════════════
// 加载入口
// ═══════════════════════════════════════════════════════════

/**
 * 从清单文件加载所有工具并注册到 registry
 *
 * 加载顺序：
 * 1. 内置工具（从 /tools/builtin/*.json 构建时内联）
 * 2. 用户工具（从 {dataDir}/tools/user/*.json 运行时通过 IPC 加载）
 *
 * 同名工具：用户清单覆盖内置清单
 */
export async function loadAllTools(registry: MCPRegistry) {
  const manifests = new Map<string, ToolManifest>();

  // ── 1. 加载内置工具 ──
  for (const [filePath, loader] of Object.entries(builtinModules)) {
    try {
      const manifest = await loader();
      if (manifest && manifest.name) {
        const errors = validateManifest(manifest, manifest.name);
        if (errors.length > 0) {
          console.warn(`[manifestLoader] 内置清单校验失败: ${manifest.name}`, errors);
          continue;
        }
        manifests.set(manifest.name, manifest);
      }
    } catch (err) {
      console.error(`[manifestLoader] 加载内置清单失败: ${filePath}`, err);
    }
  }

  // ── 2. 加载用户工具 ──
  if (window.electronAPI?.listUserToolManifests) {
    try {
      const result = await window.electronAPI.listUserToolManifests();
      if (!result.error && result.manifests) {
        for (const m of result.manifests) {
          if (m && m.name) {
            const errors = validateManifest(m, m.name);
            if (errors.length > 0) {
              console.warn(`[manifestLoader] 用户清单校验失败: ${m.name}`, errors);
              continue;
            }
            manifests.set(m.name, m as ToolManifest);
            console.log(`[manifestLoader] 加载用户工具: ${m.name}`);
          }
        }
      }
    } catch (err) {
      console.warn('[manifestLoader] 加载用户工具失败:', err);
    }
  }

  // ── 3. 注册所有工具 ──
  let registeredCount = 0;
  for (const manifest of manifests.values()) {
    const executor = resolveExecutor(manifest);
    if (!executor) {
      console.warn(`[manifestLoader] 跳过 "${manifest.name}"：未找到执行器`);
      continue;
    }

    registry.register({
      definition: manifestToToolDefinition(manifest),
      execute: wrapWithPermissions(manifest, executor),
    });

    // 存储元数据（供 permissionAware 过滤用）
    toolMetaMap.set(manifest.name, {
      category: manifest.category || 'custom',
      read: manifest.permissions.includes('allowRead'),
      write: manifest.permissions.includes('allowWrite'),
    });

    registeredCount++;
  }

  console.log(`[manifestLoader] 已注册 ${registeredCount} 个工具`);
}

/**
 * 根据清单的 executor 字段解析实际执行函数
 */
function resolveExecutor(manifest: ToolManifest): ToolExecutor['execute'] | null {
  const executor = manifest.executor;

  // builtin:xxx → 查找内置执行器
  if (typeof executor === 'string' && executor.startsWith('builtin:')) {
    const handlerName = executor.slice(8);
    const fn = builtinExecutors.get(handlerName);
    if (!fn) {
      console.warn(`[manifestLoader] 内置执行器 "${handlerName}" 未注册`);
      return null;
    }
    return fn;
  }

  // { type: "http", config: {...} } → 通用 HTTP 执行器
  if (typeof executor === 'object' && executor.type === 'http') {
    return createHttpExecutor(manifest.name, executor.config);
  }

  // { type: "shell", config: {...} } → 通用 Shell 执行器
  if (typeof executor === 'object' && executor.type === 'shell') {
    return createShellExecutor(manifest.name, executor.config);
  }

  // { type: "python_script", config: {...} } → 通用 Python 执行器
  if (typeof executor === 'object' && executor.type === 'python_script') {
    return createPythonExecutor(manifest.name, executor.config);
  }

  console.warn(`[manifestLoader] 未知执行器类型: ${JSON.stringify(executor)}`);
  return null;
}

// ═══════════════════════════════════════════════════════════
// 通用执行器工厂
// ═══════════════════════════════════════════════════════════

/**
 * 创建通用 HTTP 执行器
 * 将 manifest.executor.config 中的模板参数替换为 LLM 传入的实参
 *
 * config 示例：
 * {
 *   "method": "POST",
 *   "url": "https://hooks.example.com/notify",
 *   "headers": { "Content-Type": "application/json" },
 *   "bodyTemplate": "{\"text\": \"{{message}}\"}"
 * }
 */
function createHttpExecutor(
  toolName: string,
  config: Record<string, unknown>
): ToolExecutor['execute'] {
  return async (args: unknown, _agentId?: string | null, sessionId?: string | null) => {
    if (!window.electronAPI) throw new Error('工具仅在 Electron 桌面端版本中可用');

    const argsObj = args as Record<string, unknown>;

    // 解析 URL 模板：将 {{param}} 替换为实参值
    let url = String(config.url || '');
    url = url.replace(/\{\{(\w+)\}\}/g, (_, key) => String(argsObj[key] ?? ''));

    // 解析 body 模板
    let body: string | undefined;
    if (config.bodyTemplate) {
      body = String(config.bodyTemplate).replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = argsObj[key];
        // JSON 字符串值需要转义
        if (typeof val === 'string') return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return String(val ?? '');
      });
    }

    // 通过 tool-execute 调用主进程的 http 通用执行器
    const result = await window.electronAPI.toolExecute('__generic_http', {
      url,
      method: config.method || 'GET',
      headers: config.headers || {},
      body,
      timeout: config.timeout || 30,
      max_size: config.maxSize || 500000,
    }, sessionId);

    if (result.error) throw new Error(result.error);
    return result.content ?? `HTTP ${result.statusCode}`;
  };
}

/**
 * 创建通用 Shell 执行器
 * 在受限沙箱中执行 shell 命令
 *
 * config 示例：
 * {
 *   "command": "echo {{message}} | tr '[:lower:]' '[:upper:]'",
 *   "allowedCommands": ["echo", "tr", "cat", "grep"],
 *   "timeout": 10
 * }
 */
function createShellExecutor(
  toolName: string,
  config: Record<string, unknown>
): ToolExecutor['execute'] {
  return async (args: unknown, _agentId?: string | null, sessionId?: string | null) => {
    if (!window.electronAPI) throw new Error('工具仅在 Electron 桌面端版本中可用');

    const argsObj = args as Record<string, unknown>;

    // 解析命令模板
    let command = String(config.command || '');
    command = command.replace(/\{\{(\w+)\}\}/g, (_, key) => String(argsObj[key] ?? ''));

    const result = await window.electronAPI.toolExecute('__generic_shell', {
      command,
      allowedCommands: config.allowedCommands || [],
      timeout: config.timeout || 10,
    }, sessionId);

    if (result.error) throw new Error(result.error);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    return parts.join('\n') || '(无输出)';
  };
}

/**
 * 创建通用 Python 执行器
 * 在隔离沙箱中执行 Python 代码，支持 {{param}} 模板
 *
 * config 示例：
 * {
 *   "codeTemplate": "import json; print(json.dumps({{data}}))",
 *   "timeout": 15
 * }
 */
function createPythonExecutor(
  toolName: string,
  config: Record<string, unknown>
): ToolExecutor['execute'] {
  return async (args: unknown, _agentId?: string | null, sessionId?: string | null) => {
    if (!window.electronAPI) throw new Error('工具仅在 Electron 桌面端版本中可用');

    const argsObj = args as Record<string, unknown>;

    // 解析代码模板
    let code = String(config.codeTemplate || '');
    code = code.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = argsObj[key];
      // Python 字符串需要转义
      if (typeof val === 'string') return JSON.stringify(val);
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val ?? 'None');
    });

    const result = await window.electronAPI.toolExecute('__generic_python', {
      code,
      env_name: config.envName || null,
      timeout: config.timeout || 30,
    }, sessionId);

    if (result.error) throw new Error(result.error);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    return parts.join('\n') || '(无输出)';
  };
}