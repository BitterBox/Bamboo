import type { ToolDefinition } from '../../types';

/**
 * 工具执行器（内部接口，不对外暴露）
 * 每个 MCP 工具需实现此接口并注册到 MCPRegistry
 */
export interface ToolExecutor {
  definition: ToolDefinition;
  execute: (args: unknown, agentId?: string | null, sessionId?: string | null) => Promise<string>;
}
