// src/services/mcp/manifestTypes.ts
// 工具清单的类型定义

/**
 * 工具清单文件（JSON 格式）的完整结构
 * 每个 .json 文件对应一个工具
 */
export interface ToolManifest {
  /** 工具唯一名称，如 "read_file" */
  name: string;
  /** 语义版本号 */
  version: string;
  /** 工具类型：builtin = 内置，user = 用户安装 */
  type: 'builtin' | 'user';
  /** 作者（用户工具必填） */
  author?: string;
  /**
   * 工具类别，决定受哪个 MCP 开关控制：
   * - "file"   → fileToolEnabled
   * - "code"   → codeToolEnabled
   * - "python" → pythonToolEnabled
   * - "web"    → webToolEnabled
   * - "custom" → 始终可见（默认）
   */
  category?: 'file' | 'code' | 'python' | 'web' | 'custom';
  /** LLM 可见的函数定义 */
  function: {
    description: string;
    parameters: Record<string, unknown>;
  };
  /**
   * 执行器绑定：
   * - "builtin:xxx" → 调用内置执行器（toolExecutor.js 中的 handler）
   * - { type: "http", config: {...} } → 通用 HTTP 执行器
   * - { type: "shell", config: {...} } → 通用 Shell 执行器
   */
  executor: string | {
    type: 'http' | 'shell';
    config: Record<string, unknown>;
  };
  /** 权限声明列表 */
  permissions: string[];
}

/**
 * 从清单中提取 LLM 可见的工具定义
 */
export function manifestToToolDefinition(manifest: ToolManifest) {
  return {
    type: 'function' as const,
    function: {
      name: manifest.name,
      description: manifest.function.description,
      parameters: manifest.function.parameters,
    },
  };
}