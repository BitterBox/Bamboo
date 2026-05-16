// ============================================================
// autoNameService — 自动命名会话服务
//
// 当用户发送第一条消息时，异步调用 LLM 生成有意义的会话标题，
// 替代原来的"从消息内容截取前20字符"的简单策略。
//
// 使用模型由 settingsStore.appConfig.autoNamingModel 指定：
//   留空 → 使用默认模型（llmConfig.model）
//   "modelName" → 使用默认服务商的指定模型
//   "providerId|modelName" → 使用指定服务商的指定模型
// ============================================================

import OpenAI from 'openai';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { getActivePath } from '../utils/treeUtils';
import { resolveConfig } from './llmUtils';
import { rateLimiter } from './rateLimiter';

/**
 * 异步自动命名会话
 *
 * 读取会话的第一条用户消息，调用 LLM 生成简短标题，
 * 然后通过 renameSession 写入 store。
 *
 * 如果调用失败（网络错误、API 异常等），静默失败，
 * 保留原有的默认标题，不影响用户体验。
 *
 * @param sessionId 目标会话 ID
 */
export async function autoNameSession(sessionId: string): Promise<void> {
  const { sessions } = useChatStore.getState();
  const session = sessions[sessionId];
  if (!session) return;
  // 确保会话中已有 user 消息才尝试自动命名
  if (!Object.values(session.messageTree).some(m => m.role === 'user')) return;

  // 取第一条用户消息作为命名依据
  const activePath = getActivePath(session);
  const firstUserMessage = activePath.find((m) => m.role === 'user');
  if (!firstUserMessage || !firstUserMessage.content.trim()) return;

  // 截取前 500 字符作为命名依据，避免文件导入（论文、长文本）浪费大量输入 token
  const titleContent = firstUserMessage.content.slice(0, 500);

  const { llmConfig, apiProviders, appConfig } = useSettingsStore.getState();

  // 确定使用的模型和服务商配置
  // autoNamingModel 格式：留空="" 或 "modelName"（仅模型名，使用默认服务商）或 "providerId|modelName"（指定服务商）
  let model: string;
  let config: ReturnType<typeof resolveConfig>;
  let resolvedProviderId: string | undefined;

  const autoNameValue = appConfig.autoNamingModel;
  if (autoNameValue && autoNameValue.includes('|')) {
    // 格式 "providerId|modelName"：使用指定服务商的配置
    const pipeIdx = autoNameValue.indexOf('|');
    const providerId = autoNameValue.slice(0, pipeIdx);
    const modelName = autoNameValue.slice(pipeIdx + 1);
    const provider = apiProviders.find((p) => p.id === providerId && p.enabled);
    if (provider && modelName) {
      model = modelName;
      config = { ...llmConfig, providerId };
      resolvedProviderId = providerId;
    } else {
      // 指定服务商不存在或已禁用，回退默认
      model = llmConfig.model;
      config = resolveConfig(llmConfig, apiProviders);
      resolvedProviderId = config.providerId;
    }
  } else {
    // 仅模型名或留空：使用默认服务商
    model = autoNameValue || llmConfig.model;
    config = resolveConfig(llmConfig, apiProviders);
    resolvedProviderId = config.providerId;
  }

  // 解析服务商的 baseURL 和 apiKey（始终从 provider 获取，不依赖 config 中可能残留的旧值）
  const resolvedProvider = resolvedProviderId
    ? apiProviders.find((p) => p.id === resolvedProviderId)
    : undefined;
  const resolvedBaseURL = resolvedProvider?.baseURL ?? config.baseURL ?? '';
  const resolvedApiKey = resolvedProvider?.apiKey ?? config.apiKey ?? '';

  if (!resolvedBaseURL || !resolvedApiKey) return;

  const client = new OpenAI({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey,
    dangerouslyAllowBrowser: true,
  });

  try {
    // ── 速率限制 ──
    const rateLimitProvider = apiProviders.find((p) => p.id === resolvedProviderId);
    if (rateLimitProvider) {
      const modelInfo = rateLimitProvider.cachedModels?.find((m) => m.id === model)
        ?? rateLimitProvider.customModels?.find((m) => m.id === model);
      await rateLimiter.acquire(
        rateLimitProvider.id,
        model,
        rateLimitProvider.rateLimitPerMinute ?? 0,
        modelInfo?.rateLimitPerMinute ?? 0
      );
    }

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个对话标题生成器。根据用户的第一条消息，生成一个简短（不超过20字）且准确的中文标题。只输出标题本身，不要引号，不要多余的解释。',
        },
        {
          role: 'user',
          content: titleContent,
        },
      ],
      max_tokens: 60,
      temperature: 0.3,
      thinking: { type: 'disabled' as const },
    });

    const rawTitle = response.choices[0]?.message?.content?.trim();
    if (!rawTitle || rawTitle.length === 0) return;

    // 截断过长的标题，避免 UI 溢出
    const title = rawTitle.length > 30 ? rawTitle.slice(0, 30) + '…' : rawTitle;

    // 写入 store（使用现有的 renameSession 方法）
    const { sessions: currentSessions } = useChatStore.getState();
    if (currentSessions[sessionId]) {
      const session = currentSessions[sessionId];
      const finalTitle = session.fromGeWu ? `致知：${title}` : title;
      useChatStore.getState().renameSession(sessionId, finalTitle);
    }
  } catch (error) {
    // 自动命名失败不影响正常使用，静默失败
    console.warn('[autoName] 自动命名失败，使用默认标题:', error);
  }
}
