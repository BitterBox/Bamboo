// ============================================================
// LLM 服务层
// 封装 OpenAI SDK 的流式调用，对上层屏蔽 SDK 细节
//
// 设计决策：
//   - 每次调用时动态读取 settingsStore，无需重新实例化服务
//   - 使用 async generator 让调用方以 for-await 消费 chunk，
//     天然支持 AbortSignal 取消
//   - dangerouslyAllowBrowser: true 允许在浏览器直接调用（无代理时有 CORS 风险）
//
// 扩展指南：
//   - 支持多厂商（Anthropic/Gemini）：新增 provider 字段，
//     在 streamChat 中按 provider 选择不同 SDK
//   - CORS 代理：在 baseURL 前加代理前缀，或在 Electron 主进程转发请求
//   - 函数调用（Function Calling）：在 streamChat 参数中加入 tools 字段
// ============================================================

import OpenAI from 'openai';
import { useSettingsStore } from '../store/settingsStore';
import type { TokenUsage, ToolDefinition, ToolCall, LLMConfig, MCPConfig } from '../types';
import { resolveConfig, getModelCapabilities } from './llmUtils';
import { generateMCPSystemPrompt } from './mcp/permissionAware';
import { rateLimiter } from './rateLimiter';

export { fetchProviderModels, resolveConfig } from './llmUtils';

// ── <think> 标签流式解析辅助 ──────────────────────────────────

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/**
 * 检查 text 末尾是否为 tag 的前缀（用于识别跨 chunk 的不完整标签）
 * 返回能匹配到的最长前缀长度，0 表示不是前缀
 */
function partialTagSuffixLen(text: string, tag: string): number {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

export class LLMService {
  /**
   * 流式聊天请求（async generator）
   *
   * @param messages    完整的对话历史，格式符合 OpenAI ChatCompletion API
   * @param signal      AbortSignal，用于中途取消请求（用户点击"停止"时触发）
   * @param llmConfig   当前会话的 LLM 配置（已从 Session 直接读取，不再回退到 Agent/全局）
   * @param mcpConfig   当前会话的 MCP 配置（已从 Session 直接读取，不再回退到 Agent/全局）
   * @param onUsage     流结束后回调精确 token 用量
   * @param onReasoning 收到思考链 chunk 时的回调（reasoning_content 或 <think> 内容）
   * @yields            每个流式 chunk 的正文文本增量
   *
   * 思考链来源（按优先级）：
   *   1. delta.reasoning_content — DeepSeek-R1、部分 OpenAI 兼容 API 的专用字段
   *   2. <think>...</think> 标签 — QwQ 等模型将思考链嵌入正文内容
   *
   * ⚠️ 重要：修改此方法的请求构建逻辑时，必须同步更新 RequestInspector.tsx
   *         用户必须能从 RequestInspector 看到实际发送的请求内容
   */
  async *streamChat(
    messages: OpenAI.ChatCompletionMessageParam[],
    signal: AbortSignal | undefined,
    llmConfig: LLMConfig,
    mcpConfig: MCPConfig,
    onUsage?: (usage: TokenUsage) => void,
    onReasoning?: (chunk: string) => void,
    tools?: ToolDefinition[],
    onToolCallStart?: () => void,
    onToolCalls?: (calls: ToolCall[]) => void,
    /** 流式过程中每次 tool_calls 更新时回调（实时展示参数累积过程） */
    onToolCallsDelta?: (calls: ToolCall[]) => void,
    /** 思考模式：'auto' 根据模型能力自动决定，'enabled' 强制启用，'disabled' 强制禁用 */
    thinkingMode?: 'auto' | 'enabled' | 'disabled',
    /** 限流排队开始时回调，用于 UI 显示排队状态 */
    onRateLimited?: () => void
  ) {
    const { apiProviders } = useSettingsStore.getState();

    // 解析 providerId → 实际 baseURL/apiKey（配置已由调用方从 Session 直接读取）
    const config = resolveConfig(llmConfig, apiProviders);

    const client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      // 允许在浏览器环境运行（正式部署应通过后端代理转发以保护密钥）
      dangerouslyAllowBrowser: true,
    });

    // ── 提取消息树中的 system 根节点 ──
    // system 节点由 createSession / 加载迁移确保始终存在
    const systemContent = (messages[0].content as string) || '';
    messages = messages.slice(1);  // 移除，后续统一拼回

    // 如果启用了 MCP，添加权限信息到系统提示词
    // 使用传入的会话 MCP 配置（不再回退到 Agent/全局）
    let finalSystemPrompt = systemContent;
    if (mcpConfig.enabled && (mcpConfig.fileToolEnabled || mcpConfig.codeToolEnabled)) {
      const mcpPrompt = generateMCPSystemPrompt(mcpConfig);
      if (finalSystemPrompt) {
        finalSystemPrompt += '\n\n' + mcpPrompt;
      } else {
        finalSystemPrompt = mcpPrompt;
      }
    }

    const finalMessages = finalSystemPrompt
      ? [{ role: 'system' as const, content: finalSystemPrompt }, ...messages]
      : messages;

    // 推理模型（o1、DeepSeek-R1 等）通常不支持 temperature。
    // 但部分服务商（如 DeepSeek 官方）在开启思考模式的同时也接受温度设置，
    // 因此不再硬性跳过 temperature 参数，由各服务商的 API 自行处理。
    const isReasoning = getModelCapabilities(config.model, apiProviders).includes('reasoning');

    // ── 性能指标追踪（先于请求发起，确保首个 chunk 及之前的网络开销都被计入）──
    const streamStartTime = performance.now();

    // 发起流式请求，signal 透传给 fetch 以支持取消
    // stream_options.include_usage: 在最后一个空 chunk 里附带精确 token 用量
    //
    // thinking 参数说明（DeepSeek 扩展）：
    //   - thinkingMode 由用户手动控制，默认 'auto' 根据模型能力自动判断
    //   - 'enabled' 强制启用思考模式；'disabled' 强制禁用思考模式
    const effectiveThinkingMode = thinkingMode ?? 'auto';
    const shouldEnableThinking = effectiveThinkingMode === 'enabled'
      || (effectiveThinkingMode === 'auto' && isReasoning);

    // ── 速率限制 ──
    // 在发起 HTTP 请求之前，检查并等待服务商级和模型级的速率限制配额
    const rateLimitProvider = apiProviders.find((p) => p.id === config.providerId);
    if (rateLimitProvider) {
      const modelInfo = rateLimitProvider.cachedModels?.find((m) => m.id === config.model)
        ?? rateLimitProvider.customModels?.find((m) => m.id === config.model);
      await rateLimiter.acquire(
        rateLimitProvider.id,
        config.model,
        rateLimitProvider.rateLimitPerMinute ?? 0,
        modelInfo?.rateLimitPerMinute ?? 0,
        onRateLimited
      );
    }

    const stream = await client.chat.completions.create(
      {
        model: config.model,
        messages: finalMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(shouldEnableThinking ? { thinking: { type: 'enabled' as const }, reasoning_effort: 'high' as const } : { thinking: { type: 'disabled' as const } }),
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens }),
        ...(tools && tools.length > 0 && { tools }),
      },
      {
        signal,
        ...(config.topK !== undefined && { extra_body: { top_k: config.topK } }),
      }
    );

    // 累积流式 tool_calls（每个 chunk 可能只携带部分 arguments）
    const accToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    // ── 性能指标追踪 ──
    let firstTokenTime = 0; // 首个词元到达时间（正文或推理），0 表示尚未到达
    let lastContentTime = 0; // 最后一个正文词元到达时间

    // ── <think> 标签流式状态机 ──
    // inThinkBlock: 当前是否处于 <think>...</think> 内
    // tagBuffer:    可能是标签前缀的待确认文本（跨 chunk 时暂存）
    // thinkTagEnabled: 仅在回复开头生效；一旦输出过非空白正文即关闭，
    //   防止正文中提到的 "<think>" 字符串被误识别为思考块边界
    let inThinkBlock = false;
    let tagBuffer = '';
    let thinkTagEnabled = true;

    // 逐 chunk yield，调用方可随时通过 AbortController 中断
    for await (const chunk of stream) {
      // 首词元到达时间（含推理内容和正文）
      const contentLen = (chunk.choices[0]?.delta?.content as string)?.length ?? 0;
      const reasoningLen = (chunk.choices[0]?.delta as Record<string, unknown>)?.reasoning_content?.length ?? 0;
      const now = performance.now();
      if (firstTokenTime === 0 && (contentLen > 0 || reasoningLen > 0)) {
        firstTokenTime = now;
      }
      if (contentLen > 0) {
        lastContentTime = now;
      }

      // 0. 收集 tool_calls delta（工具调用按 index 累积）
      const deltaToolCalls = chunk.choices[0]?.delta?.tool_calls;
      if (deltaToolCalls) {
        // 首次检测到工具调用 delta 时通知上层，让 UI 可以提前显示工具调用指示器
        if (accToolCalls.size === 0 && onToolCallStart) {
          onToolCallStart();
        }
        for (const tc of deltaToolCalls) {
          const existing = accToolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          existing.arguments += tc.function?.arguments ?? '';
          accToolCalls.set(tc.index, existing);
        }
        // 实时回调当前累积的工具调用（用于流式过程中 UI 实时展示参数）
        // 🛡️ 防御：仅当有实际工具调用时才回调，防止空数组 [] 污染消息
        if (onToolCallsDelta && accToolCalls.size > 0) {
          const currentCalls: ToolCall[] = [...accToolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
          onToolCallsDelta(currentCalls);
        }
      }

      // 1. reasoning_content 字段（DeepSeek-R1 等专用字段，优先处理）
      const reasoningDelta = (chunk.choices[0]?.delta as Record<string, unknown>)?.reasoning_content;
      if (typeof reasoningDelta === 'string' && reasoningDelta && onReasoning) {
        onReasoning(reasoningDelta);
      }

      // 2. 正文 content（含 <think> 标签的解析）
      const rawContent = chunk.choices[0]?.delta?.content;
      if (rawContent) {
        // 将上一个 chunk 末尾的残留标签前缀拼上当前 chunk 一起处理
        let text = tagBuffer + rawContent;
        tagBuffer = '';

        while (text.length > 0) {
          if (!inThinkBlock) {
            // 仅当回复开头尚未输出非空白正文时，才允许检测 <think> 开标签
            const openIdx = thinkTagEnabled ? text.indexOf(OPEN_TAG) : -1;
            if (openIdx === -1) {
              // 未找到 <think>（或检测已关闭），检查末尾是否为标签前缀
              const partial = thinkTagEnabled ? partialTagSuffixLen(text, OPEN_TAG) : 0;
              if (partial > 0) {
                const safe = text.slice(0, text.length - partial);
                if (safe) {
                  if (safe.trim()) thinkTagEnabled = false;
                  yield safe;
                }
                tagBuffer = text.slice(text.length - partial);
              } else {
                if (text.trim()) thinkTagEnabled = false;
                yield text;
              }
              break;
            } else {
              // 找到 <think>，检查之前是否有非空白正文
              const before = text.slice(0, openIdx);
              if (before.trim()) {
                // <think> 前有非空白正文 → 视为普通文本，关闭标签检测
                thinkTagEnabled = false;
                yield text.slice(0, openIdx + OPEN_TAG.length);
                text = text.slice(openIdx + OPEN_TAG.length);
                // 继续循环，但 inThinkBlock 保持 false
              } else {
                // <think> 前仅有空白 → 视为真正的思考块开标签
                if (before) yield before;
                inThinkBlock = true;
                thinkTagEnabled = false;
                text = text.slice(openIdx + OPEN_TAG.length);
              }
            }
          } else {
            const closeIdx = text.indexOf(CLOSE_TAG);
            if (closeIdx === -1) {
              // 未找到 </think>，检查末尾是否是标签的前缀
              const partial = partialTagSuffixLen(text, CLOSE_TAG);
              if (partial > 0) {
                const safe = text.slice(0, text.length - partial);
                if (safe && onReasoning) onReasoning(safe);
                tagBuffer = text.slice(text.length - partial);
              } else {
                if (onReasoning) onReasoning(text);
              }
              break;
            } else {
              // 找到 </think> 闭标签
              if (closeIdx > 0 && onReasoning) onReasoning(text.slice(0, closeIdx));
              inThinkBlock = false;
              text = text.slice(closeIdx + CLOSE_TAG.length);
            }
          }
        }
      }

      // 3. token 用量（最后一个空 chunk 附带）
      if (chunk.usage && onUsage) {
        const completionTokens = chunk.usage.completion_tokens;
        const ttftMs = firstTokenTime > 0 ? firstTokenTime - streamStartTime : undefined;
        const avgMsPerToken = (ttftMs != null && lastContentTime > 0 && completionTokens > 0)
          ? (lastContentTime - firstTokenTime) / completionTokens
          : undefined;
        onUsage({
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens,
          totalTokens: chunk.usage.total_tokens,
          ttftMs: ttftMs != null ? Math.round(ttftMs) : undefined,
          avgMsPerToken: avgMsPerToken != null ? Math.round(avgMsPerToken * 10) / 10 : undefined,
          totalMs: Math.round(performance.now() - streamStartTime),
        });
      }
    }

    // 流结束，flush 残留的标签缓冲
    if (tagBuffer) {
      if (inThinkBlock && onReasoning) onReasoning(tagBuffer);
      else if (!inThinkBlock) yield tagBuffer;
    }

    // 流结束，回调工具调用列表（按 index 排序）
    if (accToolCalls.size > 0 && onToolCalls) {
      const calls: ToolCall[] = [...accToolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
      onToolCalls(calls);
    }
  }
}

/** 单例：整个应用共享同一个 LLMService 实例 */
export const llmService = new LLMService();
