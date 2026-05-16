import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useChatStore } from '../store/chatStore';
import { getActivePath } from '../utils/treeUtils';
import { useSettingsStore } from '../store/settingsStore';
import { resolveConfig, calcForceReasoningFlags } from '../services/llmUtils';
import { generateMCPSystemPrompt, getPermissionAwareToolDefinitions } from '../services/mcp';
import JsonViewer from '../components/JsonViewer';
import styles from './RequestInspector.module.css';

/**
 * API 请求预览页面
 *
 * ⚠️ 核心原则：此页面必须与 llmService.streamChat 的请求构建逻辑完全一致
 *
 * RequestInspector 的存在价值是透明性——用户必须能看到实际发送给 API 的完整请求内容。
 * 如果此页面显示的内容与实际发送的不一致，就完全失去了意义，破坏了开源软件的信任基础。
 *
 * 维护要求：
 *   - 任何修改 llmService.streamChat 请求构建逻辑的改动，必须同步更新此文件
 *   - 包括但不限于：智能体配置解析、system prompt 注入、API 参数构建
 */
export default function RequestInspector() {
  const [showRaw, setShowRaw] = useState(false);
  const location = useLocation();

  // 获取当前会话的消息
  const currentSession = useChatStore((s) =>
    s.currentSessionId ? s.sessions[s.currentSessionId] : null
  );
  const messages = currentSession ? getActivePath(currentSession) : [];
  const { apiProviders } = useSettingsStore();

  // 不可见时提前退出，避免流式期间后台空转（所有 hooks 调用之后）
  if (location.pathname !== '/inspector') return null;

  // 直接从会话配置读取（与 llmService.streamChat 保持一致：session 配置已独立）
  const sessionLLMConfig = currentSession?.llmConfig ?? { model: '' };
  const mcpConfig = currentSession?.mcpConfig ?? { ...useSettingsStore.getState().mcpConfig };
  const config = resolveConfig(sessionLLMConfig, apiProviders);

  // 提取消息树中的 system 根节点（与 llmService.streamChat 保持一致）
  let finalSystemPrompt = (messages[0]?.content as string) || '';
  // system 节点始终在 messages[0]，展示时跳过
  const msgsToShow = messages.slice(1);
  if (mcpConfig.enabled && (mcpConfig.fileToolEnabled || mcpConfig.codeToolEnabled || mcpConfig.pythonToolEnabled)) {
    const mcpPrompt = generateMCPSystemPrompt(mcpConfig);
    if (finalSystemPrompt) {
      finalSystemPrompt += '\n\n' + mcpPrompt;
    } else {
      finalSystemPrompt = mcpPrompt;
    }
  }
  const apiMessages: Record<string, unknown>[] = [];
  if (finalSystemPrompt) {
    apiMessages.push({ role: 'system', content: finalSystemPrompt });
  }
  // 区间规则：两个 user 消息之间，只要有任意 assistant 调用了工具，
  // 则区间内所有 assistant 的 reasoning_content 都必须回传
  const forceReasoningFlags = calcForceReasoningFlags(messages);
  msgsToShow.forEach((m, i) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    // msgsToShow = messages.slice(1)，索引需 +1 才能对应 forceReasoningFlags
    const flagsIdx = i + 1;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
      // 有 tool_calls：强制传 reasoning_content（LLM 没思考也要补空字符串）
      msg.reasoning_content = m.reasoning ?? '';
    } else if (m.role === 'tool' && m.toolResult) {
      msg.tool_call_id = m.toolResult.toolCallId;
    } else if (m.role === 'assistant' && flagsIdx < forceReasoningFlags.length && forceReasoningFlags[flagsIdx]) {
      // 无 tool_calls，但所在区间内有 tool_calls——也必须回传 reasoning_content
      msg.reasoning_content = m.reasoning ?? '';
    } else if (m.reasoning) {
      // 普通消息：有 reasoning 才传
      msg.reasoning_content = m.reasoning;
    }
    apiMessages.push(msg);
  });

  // 与 llmService.streamChat 保持完全一致：MCP 启用时附带 tools
  const tools = (mcpConfig.enabled && (mcpConfig.fileToolEnabled || mcpConfig.codeToolEnabled || mcpConfig.pythonToolEnabled) && window.electronAPI)
    ? getPermissionAwareToolDefinitions(currentSession?.id)
    : undefined;

  const payload = {
    baseURL: config.baseURL,
    model: config.model,
    stream: true,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    max_tokens: config.maxTokens,
    messages: apiMessages,
    ...(tools && tools.length > 0 && { tools }),
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>API 请求内容</h2>
        <span className={styles.hint}>
          当前会话：{currentSession?.title || '无会话'}
          <br />
          每次发送消息时，以下 JSON 将被发送至 API
        </span>
      </div>
      <div className={styles.toolbar}>
        <button
          className={`${styles.toggleBtn} ${showRaw ? styles.toggleBtnActive : ''}`}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? '结构化视图' : '查看原始 JSON'}
        </button>
      </div>
      <div className={styles.body}>
        {showRaw ? (
          <pre className={styles.pre}>{JSON.stringify(payload, null, 2)}</pre>
        ) : (
          <div className={styles.viewerWrapper}>
            <JsonViewer data={payload} />
          </div>
        )}
      </div>
    </div>
  );
}
