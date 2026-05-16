// ============================================================
// 全局类型定义
// 扩展指南：新增功能时优先在此文件定义数据结构，保持类型集中管理
// ============================================================

/**
 * LLM 服务配置
 * 兼容所有 OpenAI 格式的 API（如 OpenAI、Azure、本地 Ollama 等）
 * 扩展：如需支持其他参数（topP、presencePenalty 等），在此添加可选字段
 */
export interface LLMConfig {
  /**
   * API 基础地址，末尾不含斜杠，例如 https://api.openai.com/v1
   * @deprecated baseURL 属于服务商级别设置，不应在各 Session 中独立配置。
   *             运行时通过 resolveConfig() 从关联的 APIProvider 获取。
   *             保留此字段仅为向后兼容旧持久化数据。
   */
  baseURL?: string;
  /**
   * API 密钥
   * @deprecated apiKey 属于服务商级别设置，不应在各 Session 中独立配置。
   *             运行时通过 resolveConfig() 从关联的 APIProvider 获取。
   *             保留此字段仅为向后兼容旧持久化数据。
   */
  apiKey?: string;
  /** 模型名称，例如 gpt-4、gpt-4o、deepseek-chat */
  model: string;
  /** 关联的服务商 ID（设置后 baseURL/apiKey 优先从 APIProvider 读取） */
  providerId?: string;
  /** 随机性（0=确定性，2=最大创意），默认 0.7 */
  temperature?: number;
  /** 单次回复最大 token 数，不设置则使用模型默认值 */
  maxTokens?: number;
  /** Top-K 采样，限制每步候选 token 数量，不设置则使用模型默认值 */
  topK?: number;
}

/**
 * 模型能力标签
 *   chat      — 对话，能接受消息历史并返回文本（适合聊天界面）
 *   reasoning — 推理，有独立思考链，通常不支持 temperature 参数
 *   embedding — 向量嵌入，输出数字向量而非文本，不可用于聊天
 *   vision    — 视觉，支持图片输入（UI 侧暂未启用）
 *   tool-use  — 工具调用，支持 Function Calling（UI 侧暂未启用）
 */
export type ModelCapability = 'chat' | 'reasoning' | 'embedding' | 'vision' | 'tool-use';

/**
 * 带有能力元数据的模型信息
 */
export interface ModelInfo {
  id: string;
  capabilities: ModelCapability[];
  /** true = 用户手动修改过能力，重新拉取模型列表时应保留此项而非覆盖 */
  capabilitiesOverridden?: boolean;
  /** 模型级速率限制（次/分钟）：此模型独立的每分钟请求上限，0 = 不限 */
  rateLimitPerMinute?: number;
}

/**
 * API 服务商
 * 每个服务商对应一组 baseURL + apiKey，可管理多个不同的 LLM API 服务
 */
export interface APIProvider {
  /** 全局唯一 ID，由 crypto.randomUUID() 生成 */
  id: string;
  /** 用户自定义名称，如"OpenAI"、"DeepSeek"、"本地 Ollama" */
  name: string;
  /** API 基础地址，末尾不含斜杠 */
  baseURL: string;
  /** API 密钥 */
  apiKey: string;
  /** 是否启用（禁用后不显示在切换器和智能体配置中） */
  enabled: boolean;
  /** 从 API /models 端点获取的全量模型列表缓存（含能力元数据） */
  cachedModels?: ModelInfo[];
  /** 用户手动激活的模型列表（仅这些出现在模型选择器中） */
  activeModels?: string[];
  /** 用户手动添加的自定义模型（用于 API 无法自动获取模型列表的情况） */
  customModels?: ModelInfo[];
  /** cachedModels 最后获取时间戳（ms） */
  modelsLastFetched?: number;
  /** 服务商级速率限制（次/分钟）：此服务商下所有模型共享配额，0 = 不限 */
  rateLimitPerMinute?: number;
}

/**
 * 应用级配置（与 LLM 无关的通用设置）
 * 扩展：语言、主题等 UI 偏好也应放在此处
 */
export interface AppConfig {
  /** 数据文件存储目录：Electron 下为绝对路径，浏览器下为占位符 '.data' */
  dataPath: string;
  /** 消息字号（px），默认 14 */
  fontSize: number;
  /** 消息行距，默认 1.6 */
  lineHeight: number;
  /** Markdown 段落间距（em），默认 0.2 */
  paragraphSpacing: number;
  /** 自动命名会话时使用的模型。空字符串使用默认模型；纯模型名使用默认服务商；"providerId|modelName" 格式指定服务商 */
  autoNamingModel: string;
}

/**
 * API 返回的精确 token 用量（仅 assistant 消息有）
 */
export interface TokenUsage {
  /** 本次请求的 prompt token 数（含全部历史消息） */
  promptTokens: number;
  /** 本条回复的 completion token 数 */
  completionTokens: number;
  /** promptTokens + completionTokens */
  totalTokens: number;
  /** 首词元耗时（ms）：从请求发出到第一个正文/推理词元到达的时间 */
  ttftMs?: number;
  /** 平均每词元耗时（ms）：流式正文阶段从首词元到末词元的总耗时 / completionTokens */
  avgMsPerToken?: number;
  /** 总耗时（ms）：从请求发出到流完全结束的时间 */
  totalMs?: number;
}

/**
 * MCP 工具定义（OpenAI function calling 格式）
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema object
  };
}

/**
 * LLM 生成的工具调用请求
 */
export interface ToolCall {
  /** tool_call_id，原样回传给 LLM */
  id: string;
  /** 工具名称，如 "read_file" */
  name: string;
  /** JSON 字符串（LLM 原始输出） */
  arguments: string;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  /** 序列化结果或错误信息 */
  result: string;
  isError: boolean;
}

// ── 工具调用一致性修复（Reconciliation）约定 ────────────────
//
// 背景：API 规定在导出/上传对话记录时，assistant 消息的 tool_calls
// 必须与后续 tool 消息的 toolResult 一一对应（通过 toolCallId 匹配）。
// 但在实际运行中，可能因网络中断、流式防抖跨轮、手动编辑消息等
// 原因，导致对应关系断裂。
//
// 修复策略：
//   当检测到 tool_calls ↔ toolResults 不匹配时，在 assistant 消息
//   中插入一个命名约定的特殊工具调用，其 toolCallId 与后续插入的
//   工具结果消息对应，并在 arguments 中说明意外情况。
//
//   - 特殊工具名称：'_reconcile_tool_call_id'
//   - 此工具名包含下划线前缀，符合"内部/特殊"的命名约定，
//     在正常模型交互中不会与之冲突（模型通常不会主动调用此名称）。
//

/** 一致性修复特殊工具的名称 */
export const RECONCILE_TOOL_NAME = '_reconcile_tool_call_id';

/**
 * 构造一个一致性修复用的 ToolCall
 * @param description 缺失/异常的详情描述
 * @param syntheticId 可选的合成 ID（省略则自动生成）
 */
export function createReconcileToolCall(
  description: string,
  syntheticId?: string
): ToolCall {
  return {
    id: syntheticId ?? `call_reconcile_${crypto.randomUUID().slice(0, 8)}`,
    name: RECONCILE_TOOL_NAME,
    arguments: JSON.stringify({
      type: 'tool_call_id_mismatch',
      message: description,
      timestamp: Date.now(),
    }),
  };
}

/**
 * 构造一个一致性修复用的 ToolResult
 * @param toolCallId 对应的修复工具调用的 ID
 */
export function createReconcileToolResult(toolCallId: string): ToolResult {
  return {
    toolCallId,
    name: RECONCILE_TOOL_NAME,
    result: JSON.stringify({
      status: 'recorded',
      message: '[系统] 已记录工具调用ID不一致情况，已跳过此工具调用',
    }),
    isError: true,
  };
}

/**
 * MCP 配置（每个智能体独立持有）
 */
export interface MCPConfig {
  /** 是否启用 MCP 工具调用 */
  enabled: boolean;
  /** 文件工具（read_file / write_file / list_directory）是否激活 */
  fileToolEnabled: boolean;
  /** 代码工具（analyze_code / search / suggest_refactorings / modify_code）是否激活 */
  codeToolEnabled: boolean;
  /** 允许读取文件和列目录 */
  allowRead: boolean;
  /** 允许写入文件 */
  allowWrite: boolean;
  /** 允许读写的目录列表（绝对路径）；空数组表示拒绝所有路径 */
  allowedDirs: string[];
  /** Python 执行工具（run_python）是否激活 */
  pythonToolEnabled: boolean;
  /** 默认 Conda 环境名（空字符串 = 使用系统 Python）；LLM 调用 run_python 时可通过 env_name 参数覆盖 */
  condaEnv: string;
  /** Web 工具（fetch_url）是否激活 */
  webToolEnabled: boolean;
}

/** 创建新智能体时默认的 MCP 配置（全部禁用） */
export const DEFAULT_MCP_CONFIG: MCPConfig = {
  enabled: false,
  fileToolEnabled: false,
  codeToolEnabled: false,
  allowRead: false,
  allowWrite: false,
  allowedDirs: [],
  pythonToolEnabled: false,
  condaEnv: '',
  webToolEnabled: false,
};

/**
 * 单条聊天消息
 * 扩展：如需支持图片/文件，可将 content 改为联合类型或添加 attachments 字段
 */
export interface Message {
  /** 全局唯一 ID，由 crypto.randomUUID() 生成 */
  id: string;
  /** 父消息 ID。根消息（会话第一条）为 null。分支时通过 parentId 形成树结构 */
  parentId: string | null;
  /** 消息角色：user=用户，assistant=AI，system=系统提示词，tool=工具执行结果 */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 消息文本内容（待实现：Markdown 渲染） */
  content: string;
  /** 创建时间戳（ms），用于排序和显示 */
  timestamp: number;
  /** API 返回的精确 token 用量（assistant 消息在流完成后写入；用户中途停止则为 undefined） */
  tokenUsage?: TokenUsage;
  /** 思考链内容（推理模型的 reasoning_content 或 <think>...</think> 标签内容） */
  reasoning?: string;
  /** 此 assistant 消息触发的工具调用列表 */
  toolCalls?: ToolCall[];
  /** 此 tool 消息携带的工具执行结果（role === 'tool' 时有效） */
  toolResult?: ToolResult;
  /** 生成此条 assistant 消息时使用的模型名称 */
  model?: string;
  /** 生成此条 assistant 消息时使用的 API 服务商名称 */
  providerName?: string;
}

/**
 * 可配置快捷键的操作名枚举（字符串联合类型）
 * 扩展：新增可绑定操作时，在此添加新的字符串字面量
 */
export type ShortcutAction =
  | 'editMessage'       // 编辑最后一条消息
  | 'deleteMessage'     // 删除最后一条消息
  | 'retryMessage'      // 重试最后一条消息
  | 'continueFrom'      // 从此继续（保留上下文重新生成）
  | 'copyMessage'       // 复制消息内容
  | 'clearConversation'; // 清空全部对话

/**
 * 单个按键绑定字符串
 * 格式：单键 "e"、功能键 "F2"、组合键 "Ctrl+Shift+K"
 * 多个绑定同时有效（别名），用数组表示
 */
export type KeyBinding = string;

/**
 * 完整的快捷键配置表
 * key = ShortcutAction，value = 该操作的所有有效绑定列表
 */
export type ShortcutConfig = Record<ShortcutAction, KeyBinding[]>;

/**
 * 默认快捷键配置
 * 用户重置时还原到此值；首次加载时作为兜底默认值
 */
export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  editMessage:      ['Alt+e'],
  deleteMessage:    ['Alt+d'],
  retryMessage:     ['Alt+r'],
  continueFrom:     ['Alt+t'],
  copyMessage:      ['Alt+c'],
  clearConversation:['Ctrl+Shift+K'],
};

/**
 * 内置默认智能体的固定 ID，不可删除。
 * @deprecated 使用 DEFAULT_AGENT_ID 替代。保留此常量仅用于向后兼容。
 */
export const DEFAULT_ROLE_ID = 'role-default';

/**
 * @deprecated 使用 DEFAULT_AGENT_ID 替代（过渡别名，将在完成全部迁移后移除）
 */
export const DEFAULT_AGENT_ID = DEFAULT_ROLE_ID;

/**
 * 快捷短语
 * 每个智能体可配置独立的快捷短语列表，在聊天界面右侧栏点击即可插入输入框
 */
export interface QuickPhrase {
  /** 全局唯一 ID */
  id: string;
  /** 显示名称，简短描述用途，如"转md中文" */
  label: string;
  /** 实际插入的文本内容 */
  text: string;
}

/**
 * 智能体（Agent）
 * 作为会话分组容器，同时可携带系统提示词、LLM 配置和 MCP 工具权限配置。
 *
 * 设计意图：Agent 是一个独立的 AI 配置单元，拥有自己的系统提示词、
 * 模型参数和工具权限。每个会话归属于一个 Agent（通过 Session.agentId 建立关联）。
 */
export interface Agent {
  /** 全局唯一 ID，由 crypto.randomUUID() 生成；默认智能体使用固定 ID DEFAULT_AGENT_ID */
  id: string;
  /** 智能体名称，用户自定义，例如"代码助手"、"翻译官" */
  name: string;
  /** 系统提示词，发送给 LLM 的 system message */
  systemPrompt: string;
  /** 该智能体使用的 LLM 配置（完整覆盖全局配置） */
  llmConfig: LLMConfig;
  /** 是否使用自定义 API 配置（false = 使用全局配置，true = 使用智能体自己的 llmConfig） */
  useCustomConfig: boolean;
  /** 是否为内置默认智能体（true = 不可删除、不可重命名） */
  isDefault?: boolean;
  /** 快捷短语列表，可在聊天界面右侧栏一键插入 */
  quickPhrases?: QuickPhrase[];
  /** MCP 工具权限配置（每个智能体独立持有，默认全部禁用） */
  mcpConfig: MCPConfig;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后修改时间戳（ms） */
  updatedAt: number;
}

/**
 * @deprecated 使用 Agent 替代（过渡类型别名，将在完成全部迁移后移除）
 */
export type Role = Agent;

/**
 * 单个流的运行时状态。
 * 一个会话可以同时有多个活跃流（不同分支并行），每个流有独立的 execLeafId、
 * AbortController 和执行阶段标记。
 */
export interface StreamState {
  /** 该流正在写入的叶子消息 ID */
  execLeafId: string;
  /** 该流的取消控制器（用户点击停止时 abort） */
  abortController: AbortController;
  /** 该流是否在 Agent 工具执行阶段（区别于 LLM 文本输出阶段） */
  isAgentRunning: boolean;
}

/**
 * 会话（Session）
 * 每个会话包含独立的消息历史和流式状态
 */
export interface Session {
  /** 全局唯一 ID，由 crypto.randomUUID() 生成 */
  id: string;
  /** 会话标题（自动生成或用户编辑） */
  title: string;
  /**
   * 思考模式（DeepSeek 扩展）：
   *   'auto'     — 根据模型能力自动决定（推理模型启用，非推理模型禁用）
   *   'enabled'  — 强制启用思考链输出
   *   'disabled' — 强制禁用思考链输出
   */
  thinkingMode?: 'auto' | 'enabled' | 'disabled';
  /**
   * 消息树：所有消息的 Map，key = 消息 id，value = 消息对象。
   * 通过 parentId 形成树结构，根消息 parentId === null。
   * 替代原有的 messages: Message[] 线性列表。
   * 后续扩展：并发流时每个分支可独立流式，互不干扰。
   */
  messageTree: Record<string, Message>;
  /** 根消息 ID（会话的第一条消息），没有消息时为 null */
  rootMessageId: string | null;
  /** 流式执行锚点：addMessage / updateLastMessage 等流式写入的目标消息 ID */
  execLeafId: string | null;
  /** 视图锚点：getActivePath / UI 渲染使用的分支叶子 ID。非流式期间与 execLeafId 同步 */
  viewLeafId: string | null;
  /**
   * 当前活跃的流，key = execLeafId。
   * 空 Map 表示无流在跑。并发多流时每个分支有独立条目。
   * 暂存阶段：与 isStreaming / isAgentRunning / abortController 共存，
   * 后续逐步迁移到仅使用 activeStreams。
   */
  activeStreams: Map<string, StreamState>;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后更新时间戳（ms），用于排序 */
  updatedAt: number;
  /** 该会话是否正在流式响应 */
  isStreaming?: boolean;
  /** 该会话是否在 MCP Agentic Loop 中（含工具执行阶段），用于 UI 显示"停止"按钮 */
  isAgentRunning?: boolean;
  /** 该会话的取消控制器 */
  abortController?: AbortController | null;
  /** 该会话所属的智能体 ID（必填，默认使用 DEFAULT_AGENT_ID）。用于 UI 分组，不影响配置生效 */
  agentId: string;
  /** 会话级别的 LLM 配置（创建时从 Agent 快照，创建后独立。对话过程中 LLM 请求只看此配置） */
  llmConfig: LLMConfig;
  /** 会话级别的 MCP 工具权限配置（创建时从 Agent 快照，创建后独立。对话过程中 MCP 权限只看此配置） */
  mcpConfig: MCPConfig;
  /** MCP Agentic Loop 当前正在执行的工具（null = 无正在执行的工具），用于 UI 实时显示工具调用参数 */
  currentTool?: { name: string; arguments: string } | null;
  /**
   * 用户在该会话输入框中未发送的草稿文本。
   * 页面切换（路由变化导致 Chat 组件卸载/重新挂载）时，用于恢复输入框内容，
   * 避免用户辛苦打的文字丢失。每次成功发送消息后自动清空。
   */
  draft?: string;
  /** 用户是否关注（星标）此会话，关注后会话置顶于智能体组内且背景浅金色高亮 */
  isStarred?: boolean;
  /** 是否由"格物"右键菜单创建（用于自动命名时加"致知："前缀） */
  fromGeWu?: boolean;
  /** 是否在排队等待其他会话释放目录写锁 */
  isQueued?: boolean;
  /** 是否正在限流窗口排队中（等待服务商/模型速率限制配额） */
  isRateLimited?: boolean;
  /** 排队时被阻塞的文件列表（用于替换"[文件被修改]"） */
  queuedFiles?: string[];
  /** 排队时被阻塞的目录路径列表 */
  queuedDirs?: string[];
  /** 排队时持有锁的会话 ID 列表（用于 UI 显示持有者名称） */
  queuedHolderIds?: string[];
  /**
   * 是否有未读的新内容。
   * 当会话的流式输出或工具执行完成时自动设为 true（前提是用户未在查看该会话），
   * 用户切换到该会话时清除。
   */
  hasUnread?: boolean;
  /**
   * 流式缓冲区是否有未 flush 的内容（content / reasoning / toolCalls）。
   * 外部观察者（如 useAutoCommitNotify）可订阅此字段，无需轮询。
   */
  flushPending?: boolean;
  /**
   * 当前轮次的 assistant 消息 ID。
   * 用于 toolCalls 归属校验，防止跨轮写入。
   */
  currentAssistantId?: string | null;
  /**
   * 当前轮次尚未返回结果的 toolCall 数量。
   * 为 0 且 !isStreaming 且 !flushPending 时表示本轮完全结束。
   */
  pendingToolCallCount?: number;
}

/**
 * 导入的文件元数据
 * 在用户通过"导入文件"功能导入文件时记录，持久化到磁盘 {dataDir}/file/file-manifest.json
 */
export interface ImportedFileMeta {
  /** 文件在 file/ 目录下的存储路径（绝对路径，用于读取和删除操作） */
  filePath: string;
  /** 原始文件名 */
  originalName: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件 MIME 类型 */
  mimeType: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 所属会话标题（冗余，方便不查 sessions 也能展示） */
  sessionTitle: string;
  /** 对应的消息 ID（用于跳转） */
  messageId: string;
  /** 导入时间戳（ms） */
  importedAt: number;
  /** SHA-256 内容哈希（用于去重） */
  hash?: string;
}
