import type { Session, LLMConfig, MCPConfig } from '../types';
import { DEFAULT_AGENT_ID } from '../types';

/**
 * 生成会话标题
 * 策略：取第一条用户消息的前 20 字符，少于 5 字符则使用默认标题
 */
export function generateTitle(content: string): string {
  const cleaned = content.trim().replace(/\n+/g, ' ');
  if (cleaned.length < 5) {
    return `新对话 - ${new Date().toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return cleaned.length > 20 ? cleaned.slice(0, 20) + '...' : cleaned;
}

/**
 * 创建空会话
 * @param agentId 所属智能体 ID，默认归入默认智能体
 * @param llmConfig 从智能体快照的 LLM 配置（创建后独立，不再回退到智能体）
 * @param mcpConfig 从智能体快照的 MCP 配置（创建后独立，不再回退到智能体）
 */
export function createEmptySession(
  agentId: string = DEFAULT_AGENT_ID,
  llmConfig: LLMConfig,
  mcpConfig: MCPConfig,
): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: `新对话 - ${new Date().toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`,
    messageTree: {},
    rootMessageId: null,
    execLeafId: null,
    viewLeafId: null,
    activeStreams: new Map(),
    agentId,
    llmConfig: { ...llmConfig },
    mcpConfig: { ...mcpConfig },
    createdAt: now,
    updatedAt: now,
    isStreaming: false,
    isAgentRunning: false,
    abortController: null,
    currentTool: null,
    flushPending: false,
    currentAssistantId: null,
    pendingToolCallCount: 0,
  };
}
