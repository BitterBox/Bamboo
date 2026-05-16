// ============================================================
// Settings 兼容层
//
// 职责：接受任意形状的原始配置数据（null、Partial、旧格式），
// 输出完全符合类型要求的规范化数据。
//
// 这是唯一了解"兼容"的地方，其他模块在调用后无需关心兼容问题。
//
// 兼容处理范围：
//   - 文件不存在（null）→ 返回全默认值
//   - 缺失字段         → 填入默认值
//   - 旧格式字段       → 转换为新格式（如 flat baseURL/apiKey → APIProvider）
//   - 无效值           → 重置为默认值
//   - 结构性问题       → 修复（如默认智能体缺失）
// ============================================================

import type { LLMConfig, AppConfig, ShortcutConfig, Agent, Role, APIProvider, ModelCapability, ModelInfo, MCPConfig } from '../types';
import { DEFAULT_SHORTCUTS, DEFAULT_AGENT_ID, DEFAULT_MCP_CONFIG } from '../types';
import { detectCapabilities } from './llmUtils';

// ── 输出类型 ─────────────────────────────────────────────────

export interface NormalizedSettings {
  llmConfig: LLMConfig;
  shortcutConfig: ShortcutConfig;
  roles: Agent[];
  activeRoleId: string | null;
  apiProviders: APIProvider[];
  mcpConfig: MCPConfig;
}

// ── 默认值 ───────────────────────────────────────────────────

const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4',
  temperature: 0.7,
};

const DEFAULT_APP_CONFIG: AppConfig = {
  dataPath: '.data',
  fontSize: 14,
  lineHeight: 1.6,
  paragraphSpacing: 0.2,
  autoNamingModel: '',
};

/** 默认智能体的固定名称，不可由用户修改 */
const DEFAULT_ROLE_NAME = '随便聊聊';

// ── 内部辅助 ─────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function normalizeLLMConfig(raw: unknown): LLMConfig {
  const r = isObject(raw) ? raw : {};
  return {
    baseURL: isString(r.baseURL) && r.baseURL ? r.baseURL : DEFAULT_LLM_CONFIG.baseURL,
    apiKey: isString(r.apiKey) ? r.apiKey : DEFAULT_LLM_CONFIG.apiKey,
    model: isString(r.model) && r.model ? r.model : DEFAULT_LLM_CONFIG.model,
    ...(isString(r.providerId) && r.providerId ? { providerId: r.providerId } : {}),
    ...(isNumber(r.temperature) ? { temperature: r.temperature } : { temperature: DEFAULT_LLM_CONFIG.temperature }),
    ...(isNumber(r.maxTokens) && r.maxTokens > 0 ? { maxTokens: r.maxTokens } : {}),
    ...(isNumber(r.topK) && r.topK > 0 ? { topK: r.topK } : {}),
  };
}

const VALID_CAPABILITIES = new Set<string>(['chat', 'reasoning', 'embedding', 'vision', 'tool-use']);

/**
 * 规范化单个模型条目
 * 兼容旧格式（纯字符串）和新格式（ModelInfo 对象）
 */
function normalizeModelInfo(raw: unknown): ModelInfo | null {
  // 旧格式：纯字符串 model ID
  if (typeof raw === 'string' && raw) {
    return { id: raw, capabilities: detectCapabilities(raw) };
  }
  if (!isObject(raw) || !isString(raw.id) || !raw.id) return null;
  // 新格式：ModelInfo 对象
  const caps = Array.isArray(raw.capabilities)
    ? (raw.capabilities as unknown[]).filter((c): c is ModelCapability =>
        typeof c === 'string' && VALID_CAPABILITIES.has(c))
    : [];
  return {
    id: raw.id,
    // 若 capabilities 为空（损坏数据），fallback 到自动识别
    capabilities: caps.length > 0 ? caps : detectCapabilities(raw.id),
    ...(raw.capabilitiesOverridden === true ? { capabilitiesOverridden: true } : {}),
    ...(isNumber(raw.rateLimitPerMinute) ? { rateLimitPerMinute: raw.rateLimitPerMinute } : {}),
  };
}

function normalizeAPIProvider(raw: unknown): APIProvider | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || !raw.id) return null;
  if (!isString(raw.baseURL) || !raw.baseURL) return null;
  return {
    id: raw.id,
    name: isString(raw.name) && raw.name ? raw.name : '未命名服务商',
    baseURL: raw.baseURL,
    apiKey: isString(raw.apiKey) ? raw.apiKey : '',
    enabled: raw.enabled !== false,
    ...(Array.isArray(raw.cachedModels)
      ? { cachedModels: raw.cachedModels.map(normalizeModelInfo).filter((m): m is ModelInfo => m !== null) }
      : {}),
    ...(Array.isArray(raw.activeModels) ? { activeModels: raw.activeModels.filter(isString) } : {}),
    ...(Array.isArray(raw.customModels)
      ? { customModels: raw.customModels.map(normalizeModelInfo).filter((m): m is ModelInfo => m !== null) }
      : {}),
    ...(isNumber(raw.modelsLastFetched) ? { modelsLastFetched: raw.modelsLastFetched } : {}),
    ...(isNumber(raw.rateLimitPerMinute) ? { rateLimitPerMinute: raw.rateLimitPerMinute } : {}),
  };
}

function normalizeAPIProviders(raw: unknown): APIProvider[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAPIProvider).filter((p): p is APIProvider => p !== null);
}

/**
 * 旧格式迁移：若 providers 为空但 llmConfig.baseURL 有值，
 * 自动将 baseURL/apiKey 包装为默认 provider。
 */
function migrateToProviders(
  llmConfig: LLMConfig,
  providers: APIProvider[]
): { llmConfig: LLMConfig; apiProviders: APIProvider[] } {
  if (providers.length > 0) return { llmConfig, apiProviders: providers };
  if (!llmConfig.baseURL) return { llmConfig, apiProviders: [] };
  const providerId = crypto.randomUUID();
  const defaultProvider: APIProvider = {
    id: providerId,
    name: '默认',
    baseURL: llmConfig.baseURL ?? '',
    apiKey: llmConfig.apiKey ?? '',
    enabled: true,
    ...(llmConfig.model ? { activeModels: [llmConfig.model] } : {}),
  };
  return {
    llmConfig: { ...llmConfig, providerId },
    apiProviders: [defaultProvider],
  };
}

function normalizeShortcutConfig(raw: unknown): ShortcutConfig {
  const r = isObject(raw) ? raw : {};

  // 逐个字段校验：确保每个 shortcut 的值是 string[]，否则回退到默认值
  const validated: Record<string, string[]> = {};
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as (keyof ShortcutConfig)[]) {
    const rawValue = (r as Record<string, unknown>)[action];
    validated[action] = Array.isArray(rawValue) && rawValue.every((v) => typeof v === 'string')
      ? rawValue
      : [...DEFAULT_SHORTCUTS[action]];
  }

  return validated as ShortcutConfig;
}

/** 构建默认智能体（使用 DEFAULT_AGENT_ID） */
function buildDefaultAgent(llmConfig: LLMConfig): Agent {
  return {
    id: DEFAULT_AGENT_ID,
    name: DEFAULT_ROLE_NAME,
    systemPrompt: '',
    llmConfig,
    useCustomConfig: false,
    isDefault: true,
    mcpConfig: { ...DEFAULT_MCP_CONFIG },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 规范化 MCP 配置；缺失字段按默认值（全部禁用）填充 */
function normalizeMCPConfig(raw: unknown): MCPConfig {
  if (!isObject(raw)) return { ...DEFAULT_MCP_CONFIG };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_MCP_CONFIG.enabled,
    fileToolEnabled: typeof raw.fileToolEnabled === 'boolean' ? raw.fileToolEnabled : DEFAULT_MCP_CONFIG.fileToolEnabled,
    codeToolEnabled: typeof raw.codeToolEnabled === 'boolean' ? raw.codeToolEnabled : DEFAULT_MCP_CONFIG.codeToolEnabled,
    allowRead: typeof raw.allowRead === 'boolean' ? raw.allowRead : DEFAULT_MCP_CONFIG.allowRead,
    allowWrite: typeof raw.allowWrite === 'boolean' ? raw.allowWrite : DEFAULT_MCP_CONFIG.allowWrite,
    allowedDirs: Array.isArray(raw.allowedDirs)
      ? raw.allowedDirs.filter(isString)
      : DEFAULT_MCP_CONFIG.allowedDirs,
    pythonToolEnabled: typeof raw.pythonToolEnabled === 'boolean' ? raw.pythonToolEnabled : DEFAULT_MCP_CONFIG.pythonToolEnabled,
    condaEnv: isString(raw.condaEnv) ? raw.condaEnv : DEFAULT_MCP_CONFIG.condaEnv,
    webToolEnabled: typeof raw.webToolEnabled === 'boolean' ? raw.webToolEnabled : DEFAULT_MCP_CONFIG.webToolEnabled,
  };
}

function normalizeRole(raw: unknown, fallbackLLMConfig: LLMConfig): Agent | null {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || !raw.id) return null;
  return {
    id: raw.id,
    name: isString(raw.name) && raw.name ? raw.name : '未命名智能体',
    systemPrompt: isString(raw.systemPrompt) ? raw.systemPrompt : '',
    llmConfig: normalizeLLMConfig(isObject(raw.llmConfig) ? raw.llmConfig : fallbackLLMConfig),
    useCustomConfig: raw.useCustomConfig === true,
    ...(raw.isDefault === true ? { isDefault: true } : {}),
    quickPhrases: Array.isArray(raw.quickPhrases)
      ? raw.quickPhrases.filter(
          (p): p is { id: string; label: string; text: string } =>
            isObject(p) && isString(p.id) && isString(p.label) && isString(p.text)
        )
      : [],
    mcpConfig: normalizeMCPConfig(raw.mcpConfig),
    createdAt: isNumber(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: isNumber(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

function normalizeRoles(raw: unknown, llmConfig: LLMConfig): Agent[] {
  const list = Array.isArray(raw)
    ? raw.map((r) => normalizeRole(r, llmConfig)).filter((r): r is Agent => r !== null)
    : [];
  // 确保默认智能体始终存在，且名称正确
  const defaultIdx = list.findIndex((r) => r.id === DEFAULT_AGENT_ID);
  if (defaultIdx >= 0) {
    list[defaultIdx] = { ...list[defaultIdx], name: DEFAULT_ROLE_NAME };
    return list;
  }
  return [buildDefaultAgent(llmConfig), ...list];
}

function normalizeActiveRoleId(raw: unknown, roles: Role[]): string | null {
  if (!isString(raw) || !raw) return null;
  return roles.some((r) => r.id === raw) ? raw : null;
}

// ── 导出函数 ─────────────────────────────────────────────────

/**
 * 规范化 settings.json / localStorage state 字段。
 * 输入可为 null、任意 Partial 或旧格式数据，输出保证完整有效。
 */
export function normalizeSettings(raw: unknown): NormalizedSettings {
  const r = isObject(raw) ? raw : {};

  const llmConfigRaw = normalizeLLMConfig(r.llmConfig);
  const providersRaw = normalizeAPIProviders(r.apiProviders);
  const { llmConfig, apiProviders } = migrateToProviders(llmConfigRaw, providersRaw);

  const shortcutConfig = normalizeShortcutConfig(r.shortcutConfig);
  const roles = normalizeRoles(r.roles, llmConfig);
  const activeRoleId = normalizeActiveRoleId(r.activeRoleId, roles);

  const mcpConfig = normalizeMCPConfig(r.mcpConfig)

  return { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig };
}

/**
 * 规范化 app-config.json 数据（仅含 dataPath）与 settings.json 中的 appConfig 合并后的结果。
 * @param defaultPath - dataPath 的兜底值（由 IPC 获取，仅 Electron 有意义）
 */
export function normalizeAppConfig(raw: unknown, defaultPath: string): AppConfig {
  const r = isObject(raw) ? raw : {};
  return {
    dataPath: (isString(r.dataPath) && r.dataPath) ? r.dataPath : defaultPath,
    fontSize: isNumber(r.fontSize) ? r.fontSize : DEFAULT_APP_CONFIG.fontSize,
    lineHeight: isNumber(r.lineHeight) ? r.lineHeight : DEFAULT_APP_CONFIG.lineHeight,
    paragraphSpacing: isNumber(r.paragraphSpacing) ? r.paragraphSpacing : DEFAULT_APP_CONFIG.paragraphSpacing,
    autoNamingModel: isString(r.autoNamingModel) ? r.autoNamingModel : DEFAULT_APP_CONFIG.autoNamingModel,
  };
}
