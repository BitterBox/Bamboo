// ============================================================
// LLM 工具函数（无循环依赖，可被 store 和 service 共同引用）
// ============================================================

import OpenAI from 'openai';
import type { LLMConfig, APIProvider, ModelCapability, ModelInfo, Message } from '../types';
import { reconcileToolCalls } from '../utils/reconcileToolCalls';

/**
 * 根据模型 ID 自动识别其能力
 *
 * 策略：保守默认 ['chat']，再通过名称模式追加额外能力。
 * 识别规则：
 *   - embed          → embedding（向量模型，不可用于聊天）
 *   - moderat        → []（内容审核，不适合聊天）
 *   - o1/o3/qwq/deepseek-r → reasoning（推理模型，不支持 temperature）
 *   - vision/vl/visual     → vision（视觉模型）
 */
export function detectCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();

  if (/embed/.test(id)) return ['embedding'];
  if (/moderat/.test(id)) return [];

  const caps = new Set<ModelCapability>(['chat']);

  // 推理模型：\bo[1-9]\b 匹配 o1/o3 但不匹配 4o；\br\d-\d 匹配 r1-7b 等
  if (/\bo[1-9]\b|-o[1-9]-|qwq|deepseek-r\d|\br\d-\d|reasoner/.test(id)) {
    caps.add('reasoning');
  }

  // 视觉模型
  if (/vision|-vl\b|\bvl\b|-vl-|visual/.test(id)) {
    caps.add('vision');
  }

  return Array.from(caps);
}

/**
 * 从 cachedModels 中筛选出支持聊天的模型
 */
export function getChatModels(cachedModels: ModelInfo[] | undefined): ModelInfo[] {
  return (cachedModels ?? []).filter((m) => m.capabilities.includes('chat'));
}

/**
 * 合并 cachedModels 和 customModels，返回全量模型列表
 * customModels 中的同名模型会覆盖 cachedModels（用户自定义优先）
 */
export function getAllModels(provider: { cachedModels?: ModelInfo[]; customModels?: ModelInfo[] } | undefined): ModelInfo[] {
  if (!provider) return [];
  const cached = provider.cachedModels ?? [];
  const custom = provider.customModels ?? [];
  const customIds = new Set(custom.map((m) => m.id));
  // 先从 cached 中排除已在 custom 中的（自定义优先）
  const filtered = cached.filter((m) => !customIds.has(m.id));
  return [...filtered, ...custom].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 查询指定模型 ID 的能力列表
 * 优先从 providers.cachedModels/customModels 中查找；查不到则 fallback 到 detectCapabilities
 */
export function getModelCapabilities(modelId: string, providers: APIProvider[]): ModelCapability[] {
  for (const p of providers) {
    const found = p.cachedModels?.find((m) => m.id === modelId)
      ?? p.customModels?.find((m) => m.id === modelId);
    if (found) return found.capabilities;
  }
  return detectCapabilities(modelId);
}

/**
 * 将用户配置的 baseURL 标准化为模型列表 API 可用的地址
 *
 * 背景：部分服务商（如 DeepSeek）允许用户将 baseURL 配置为 /beta 等非标准路径
 * 用于解锁测试功能，但模型列表端点 `/models` 仅在标准 /v1 路径下可用。
 * 因此这里将路径中末尾的非标准段替换为 /v1：
 *   https://api.deepseek.com        → https://api.deepseek.com/v1
 *   https://api.deepseek.com/beta   → https://api.deepseek.com/v1
 *   https://api.openai.com/v1       → 保持不变
 */
function normalizeModelsBaseURL(baseURL: string): string {
  const url = baseURL.replace(/\/+$/, ''); // 去掉尾部斜杠
  // 如果已经以 /v1 结尾，直接返回
  if (url.endsWith('/v1')) return url;
  // 否则将最后一个路径段替换为 /v1
  const lastSlash = url.lastIndexOf('/');
  // 如果最后一个斜杠在协议标识符之后（即 http:// 或 https:// 之后）
  const protocolEnd = url.indexOf('://');
  if (lastSlash > protocolEnd + 2) {
    // 有路径段，替换最后一个段为 v1
    return url.substring(0, lastSlash) + '/v1';
  }
  // 没有路径段（如 https://api.deepseek.com），直接追加 /v1
  return url + '/v1';
}

/**
 * 从 OpenAI 兼容 API 获取可用模型列表（含自动识别的能力元数据）
 * @param baseURL API 基础地址
 * @param apiKey API 密钥
 * @returns 按字母排序的 ModelInfo 列表
 * @throws 网络错误、认证错误等都会被包装后抛出
 */
export async function fetchProviderModels(baseURL: string, apiKey: string): Promise<ModelInfo[]> {
  // 模型列表 API 始终使用 /v1 路径（兼容 DeepSeek 等将 /beta 用于对话但 /v1 用于模型列表的服务商）
  const modelsBaseURL = normalizeModelsBaseURL(baseURL);

  let client: OpenAI;
  try {
    client = new OpenAI({ baseURL: modelsBaseURL, apiKey, dangerouslyAllowBrowser: true });
  } catch (err) {
    throw new Error(`初始化 OpenAI 客户端失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  let response: OpenAI.Models.ModelsPage;
  try {
    response = await client.models.list();
  } catch (err: unknown) {
    // 提取 OpenAI API 错误中的详细信息
    if (err instanceof OpenAI.APIError) {
      throw new Error(
        `API 请求失败 [${err.status}]: ${err.message}${err.code ? ` (code: ${err.code})` : ''}`
      );
    }
    if (err instanceof Error) {
      // 网络错误（fetch 失败、超时、DNS 解析失败等）
      if (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Network')) {
        throw new Error(`网络请求失败，请检查 API 地址是否可访问: ${err.message}`);
      }
      throw new Error(`获取模型列表失败: ${err.message}`);
    }
    throw new Error(`获取模型列表失败: 未知错误`);
  }

  return response.data
    .map((m) => ({ id: m.id, capabilities: detectCapabilities(m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 解析最终生效的 LLM 配置
 * baseURL 和 apiKey 始终从服务商解析，不再依赖 config 中可能遗留的旧值。
 * 若未关联服务商或服务商不存在，baseURL/apiKey 返回空字符串。
 */
export function resolveConfig(config: LLMConfig, providers: APIProvider[]): LLMConfig {
  if (!config.providerId) return { ...config, baseURL: '', apiKey: '' };
  const provider = providers.find((p) => p.id === config.providerId);
  if (!provider) return { ...config, baseURL: '', apiKey: '' };
  return { ...config, baseURL: provider.baseURL, apiKey: provider.apiKey };
}

/**
 * 对消息列表执行工具调用一致性修复，确保 tool_calls 与 tool 结果一一对应
 *
 * 在将消息列表发送给 LLM API 之前调用，防止因本地数据不一致导致 API 报错。
 * 这是一个安全的无副作用操作：如果消息已经一致，不会做任何修改。
 *
 * @param messages 原始消息列表
 * @returns 修复后的消息列表（若无需修复则返回原始引用）
 */
export function reconcileContextMessages(
  messages: Message[]
): Message[] {
  return reconcileToolCalls(messages);
}

/**
 * 将单条内部 Message 转换为 OpenAI API 格式
 *
 * @param message    待转换的消息
 * @param options.forceReasoning  即使没有 reasoning 字段也强制传 reasoning_content（用于区间内有 tool_calls 的 assistant 消息）
 *
 * DeepSeek reasoning_content 回传规则：
 *   - 在两个 user 消息之间，如果模型未进行工具调用，则中间 assistant 的
 *     reasoning_content 无需参与上下文拼接（传入 API 会被忽略）。
 *   - 在两个 user 消息之间，如果模型进行了工具调用，则中间 assistant 的
 *     reasoning_content 必须参与上下文拼接，在后续所有 user 交互轮次中必须
 *     回传给 API，否则 API 会返回 400 错误。
 *
 * 注意：单条转换无法感知区间内是否有 tool_calls，请在批量转换
 *       (toOpenAIMessages) 中使用以实现完整的区间规则。
 */
export function toOpenAIMessage(
  message: Message,
  options?: { forceReasoning?: boolean },
): OpenAI.ChatCompletionMessageParam {
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    // 包含工具调用的assistant消息 — 必须回传 reasoning_content
    const msg = {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
      // 有 tool_calls 时必须回传 reasoning_content（LLM 没产生思考也要补空字符串，否则 API 400）
      reasoning_content: message.reasoning ?? '',
    };
    return msg as OpenAI.ChatCompletionMessageParam;
  } else if (message.role === 'tool' && message.toolResult) {
    // 工具结果消息
    const msg = {
      role: 'tool',
      tool_call_id: message.toolResult.toolCallId,
      content: message.toolResult.result,
    };
    return msg as OpenAI.ChatCompletionMessageParam;
  } else {
    // 普通消息（user / assistant 无 tool_calls / system）
    // forceReasoning：仅对 assistant 生效——所在区间内有 tool_calls，必须回传
    const shouldSendReasoning =
      (options?.forceReasoning && message.role === 'assistant') || message.reasoning;
    return {
      role: message.role,
      content: message.content,
      ...(shouldSendReasoning ? { reasoning_content: message.reasoning ?? '' } : {}),
    } as OpenAI.ChatCompletionMessageParam;
  }
}

/**
 * 批量将内部 Message 列表转换为 OpenAI API 格式
 *
 * 与 toOpenAIMessage 不同，此函数接收完整消息列表，能够根据
 * DeepSeek 区间规则正确判断每条 assistant 消息是否需要强制回传 reasoning_content：
 *
 *   "在两个 user 消息之间，如果模型进行了工具调用，则中间 **所有** assistant 的
 *    reasoning_content 必须参与上下文拼接"
 *
 * 使用方式：
 *   const apiMessages = toOpenAIMessages(reconciledMessages);
 */
export function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const forceReasoningFlags = calcForceReasoningFlags(messages);
  return messages.map((msg, i) => toOpenAIMessage(msg, { forceReasoning: forceReasoningFlags[i] }));
}

/**
 * 扫描消息列表，计算每条 assistant 消息是否需要强制传 reasoning_content
 *
 * 算法：
 *   1. 找到所有 user 消息的位置，将列表划分为多个"user→user 区间"
 *   2. 对每个区间，检查是否有 assistant 消息携带 tool_calls
 *   3. 如果有，则该区间内所有 assistant 消息标记为需强制传 reasoning_content
 */
export function calcForceReasoningFlags(messages: Message[]): boolean[] {
  const flags = new Array<boolean>(messages.length).fill(false);

  // 1. 找到所有 user 消息的索引
  const userIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIndices.push(i);
  });

  // 2. 划分区间
  const ranges: Array<{ start: number; end: number }> = [];

  if (userIndices.length === 0) {
    // 没有 user 消息，整个列表为一个区间
    ranges.push({ start: 0, end: messages.length });
  } else {
    // 第一个 user 之前的消息
    if (userIndices[0] > 0) ranges.push({ start: 0, end: userIndices[0] });
    // 相邻 user 之间的消息（排除 user 自身）
    for (let i = 1; i < userIndices.length; i++) {
      if (userIndices[i] - userIndices[i - 1] > 1) {
        ranges.push({ start: userIndices[i - 1] + 1, end: userIndices[i] });
      }
    }
    // 最后一个 user 之后的消息
    if (userIndices[userIndices.length - 1] < messages.length - 1) {
      ranges.push({ start: userIndices[userIndices.length - 1] + 1, end: messages.length });
    }
  }

  // 3. 检查每个区间内是否有 tool_calls
  for (const range of ranges) {
    let hasToolCallsInRange = false;
    for (let i = range.start; i < range.end; i++) {
      if (messages[i].role === 'assistant' && messages[i].toolCalls && messages[i].toolCalls.length > 0) {
        hasToolCallsInRange = true;
        break;
      }
    }
    if (hasToolCallsInRange) {
      for (let i = range.start; i < range.end; i++) {
        if (messages[i].role === 'assistant') {
          flags[i] = true;
        }
      }
    }
  }

  return flags;
}