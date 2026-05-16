// ============================================================
// 设置状态管理（Zustand store）
// 负责 LLM 配置、应用配置、快捷键配置的读取与持久化
//
// 持久化策略：
//   Electron 环境 → IPC → userData/app-config.json（仅 dataPath）+ dataDir/settings.json
//   浏览器环境   → localStorage key: 'app-settings'
//
// 扩展指南：
//   - 新增配置项：在对应 interface（LLMConfig/AppConfig）添加字段，
//     并在 loadSettings/saveSettings 中同步处理
//   - 新增配置分组：仿照 llmConfig 模式添加新的 state + update 方法
// ============================================================

import { create } from 'zustand';
import type { LLMConfig, AppConfig, ShortcutConfig, Agent, Role, APIProvider, MCPConfig } from '../types';
import { DEFAULT_AGENT_ID, DEFAULT_MCP_CONFIG } from '../types';
import { fetchProviderModels, resolveConfig, getAllModels } from '../services/llmUtils';
import { normalizeSettings, normalizeAppConfig } from '../services/settingsCompat';

// ── Store 接口 ──────────────────────────────────────────────

interface SettingsStore {
  /** LLM 连接与模型参数 */
  llmConfig: LLMConfig;
  /** 应用级配置（数据路径等） */
  appConfig: AppConfig;
  /** 键盘快捷键绑定表 */
  shortcutConfig: ShortcutConfig;
  /** 是否已完成初始加载（用于阻塞渲染直到数据就绪） */
  isLoaded: boolean;
  /** 是否需要用户配置数据路径（未显式设置过 dataPath 时为 true） */
  needsDataPathSetup: boolean;
  /** 所有智能体列表
   *  @note 字段名保留 `roles` 以兼容持久化数据；语义上等同于 `agents: Agent[]` */
  roles: Agent[];
  /** 当前激活的智能体 ID（null = 使用全局配置）
   *  @note 变量名保留 `activeRoleId`；语义上等同于 `activeAgentId` */
  activeRoleId: string | null;
  /** 所有 API 服务商列表 */
  apiProviders: APIProvider[];
  /** MCP 工具调用配置 */
  mcpConfig: MCPConfig;
  /** 正在获取模型列表的服务商 ID → boolean 映射 */
  fetchingModels: Record<string, boolean>;
  /** 获取模型列表的错误信息（providerId → 错误消息） */
  fetchModelsError: Record<string, string>;

  /** 局部更新 LLM 配置并立即持久化 */
  updateLLMConfig: (config: Partial<LLMConfig>) => void;
  /** 局部更新应用配置并立即持久化 */
  updateAppConfig: (config: Partial<AppConfig>) => void;
  /** 局部更新快捷键配置并立即持久化 */
  updateShortcutConfig: (patch: Partial<ShortcutConfig>) => void;

  /** 从持久化层加载全部设置（应用启动时由 DataLoader 调用一次） */
  loadSettings: () => Promise<void>;
  /** 将 llmConfig + shortcutConfig 写入持久化层 */
  saveSettings: () => Promise<void>;
  /** 将 appConfig 单独写入持久化层（路径变更时调用） */
  saveAppConfig: () => Promise<void>;

  /** 创建新智能体（基于当前 llmConfig 初始化）
   *  @note 方法名保留 `createRole`，语义上即 createAgent */
  createRole: (name: string, systemPrompt: string, llmConfig?: Partial<LLMConfig>, useCustomConfig?: boolean, mcpConfig?: Partial<MCPConfig>) => string;
  /** 更新智能体
   *  @note 方法名保留 `updateRole`，语义上即 updateAgent */
  updateRole: (id: string, patch: Partial<Omit<Agent, 'id' | 'createdAt'>>) => void;
  /** 删除智能体
   *  @note 方法名保留 `deleteRole`，语义上即 deleteAgent */
  deleteRole: (id: string) => void;
  /** 重新排序智能体（拖拽后调用）
   *  @note 方法名保留 `reorderRoles`，语义上即 reorderAgents */
  reorderRoles: (fromIndex: number, toIndex: number) => void;
  /** 直接设置智能体顺序（Framer Motion Reorder 回调使用） */
  setAgentsOrder: (orderedAgents: Role[]) => void;
  /** 切换当前激活智能体
   *  @note 方法名保留 `setActiveRole`，语义上即 setActiveAgent */
  setActiveRole: (id: string | null) => void;
  /** 获取当前生效的 LLM 配置（智能体配置优先于全局配置，并解析 providerId） */
  getEffectiveLLMConfig: () => LLMConfig;

  /** 添加服务商 */
  addAPIProvider: (provider: Omit<APIProvider, 'id'>) => string;
  /** 更新服务商 */
  updateAPIProvider: (id: string, patch: Partial<Omit<APIProvider, 'id'>>) => void;
  /** 删除服务商 */
  deleteAPIProvider: (id: string) => void;
  /** 将指定服务商设为默认（更新 llmConfig.providerId/baseURL/apiKey） */
  setDefaultProvider: (id: string) => void;
  /** 从服务商 API 获取模型列表并缓存到 provider.cachedModels */
  fetchModels: (providerId: string) => Promise<void>;
  /** 为服务商添加自定义模型（用于 API 无法自动获取模型列表的情况） */
  addCustomModel: (providerId: string, modelId: string, capabilities?: ModelCapability[]) => void;
  /** 删除服务商的自定义模型 */
  removeCustomModel: (providerId: string, modelId: string) => void;
}

// ── 辅助 ─────────────────────────────────────────────────────

const _initialSettings = normalizeSettings(null);
const _initialAppConfig = normalizeAppConfig(null, '');

const SETTINGS_STORE_KEY = '__ZUSTAND_SETTINGS_STORE__';
export const useSettingsStore = (window as any)[SETTINGS_STORE_KEY] ?? ((window as any)[SETTINGS_STORE_KEY] = create<SettingsStore>()((set, get) => ({
  llmConfig: _initialSettings.llmConfig,
  appConfig: _initialAppConfig,
  shortcutConfig: _initialSettings.shortcutConfig,
  isLoaded: false,
  needsDataPathSetup: true,
  roles: _initialSettings.roles,
  activeRoleId: _initialSettings.activeRoleId,
  apiProviders: _initialSettings.apiProviders,
  mcpConfig: _initialSettings.mcpConfig,
  fetchingModels: {},
  fetchModelsError: {},

  // ── 更新方法（合并更新 + 触发持久化）──────────────────────

  updateLLMConfig: (config) => {
    set((state) => ({
      llmConfig: { ...state.llmConfig, ...config },
      // 同步更新默认智能体的 LLM 配置，确保「随便聊聊」始终跟随全局设置
      roles: state.roles.map((r) =>
        r.id === DEFAULT_AGENT_ID
          ? { ...r, llmConfig: { ...r.llmConfig, ...config }, updatedAt: Date.now() }
          : r
      ),
    }));
    // 配置变更后立即持久化，保证 UI 操作与存储同步
    get().saveSettings();
  },

  updateAppConfig: (config) => {
    set((state) => ({
      appConfig: { ...state.appConfig, ...config },
    }));
    // dataPath 变更 → 写入 app-config.json（userData 下）
    if ('dataPath' in config) {
      get().saveAppConfig();
    }
    // 非 dataPath 字段变更 → 写入 settings.json（dataDir 下）
    const hasNonDataPath = Object.keys(config).some(k => k !== 'dataPath');
    if (hasNonDataPath) {
      get().saveSettings();
    }
  },

  updateShortcutConfig: (patch) => {
    set((state) => ({
      shortcutConfig: { ...state.shortcutConfig, ...patch },
    }));
    // 快捷键与 llmConfig 一起存入 settings.json / localStorage
    get().saveSettings();
  },

  // ── 加载（启动时执行一次）─────────────────────────────────

  loadSettings: async () => {
    if (window.electronAPI) {
      const [settingsData, appConfigData, needsSetup] = await Promise.all([
        window.electronAPI.readSettings(),
        window.electronAPI.readAppConfig(),
        window.electronAPI.needsDataPathSetup(),
      ]);
      const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig } = normalizeSettings(settingsData);
      // appConfigData 只含 dataPath；其余字段（fontSize 等）从 settings.json 中读取
      const settingsAppConfig = (settingsData && typeof settingsData === 'object' && !Array.isArray(settingsData) && settingsData.appConfig)
        ? settingsData.appConfig : {};
      const appConfig = normalizeAppConfig({ ...settingsAppConfig, ...appConfigData }, '');
      set({ llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig, appConfig, isLoaded: true, needsDataPathSetup: needsSetup });
    } else {
      const stored = localStorage.getItem('app-settings');
      if (stored) {
        try {
          const data = JSON.parse(stored);
          const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig } = normalizeSettings(data.state);
          const appConfig = normalizeAppConfig(data.state?.appConfig, '.data');
          set({ llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig, appConfig, isLoaded: true });
        } catch (error) {
          console.error('Failed to parse settings:', error);
          localStorage.removeItem('app-settings');
          const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig } = normalizeSettings(null);
          const appConfig = normalizeAppConfig(null, '.data');
          set({ llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig, appConfig, isLoaded: true });
        }
      } else {
        const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig } = normalizeSettings(null);
        const appConfig = normalizeAppConfig(null, '.data');
        set({ llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig, appConfig, isLoaded: true });
      }
    }
  },

  // ── 持久化（每次配置变更后调用）──────────────────────────

  /**
   * 保存 LLM 配置和快捷键配置
   * 注意：appConfig（数据路径）单独由 saveAppConfig 处理
   */
  saveSettings: async () => {
    const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig, appConfig } = get();
    // 从 appConfig 中剔除 dataPath（dataPath 单独存储在 app-config.json）
    const { dataPath: _, ...appConfigWithoutDataPath } = appConfig;
    if (window.electronAPI) {
      await window.electronAPI.writeSettings({ llmConfig, appConfig: appConfigWithoutDataPath, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig });
    } else {
      localStorage.setItem(
        'app-settings',
        JSON.stringify({ state: { llmConfig, appConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig }, version: 0 })
      );
    }
  },

  /**
   * 单独保存数据路径（dataPath 变更时使用）
   * Electron 下仅将 dataPath 写入 app-config.json，其余设置由 saveSettings 处理
   */
  saveAppConfig: async () => {
    const { appConfig } = get();
    if (window.electronAPI) {
      // 只将 dataPath 写入 app-config.json，其余设置已在 settings.json 中
      await window.electronAPI.writeAppConfig({ dataPath: appConfig.dataPath });
      // 用户保存了 dataPath 后，重新检查是否还需要设置
      const needsSetup = await window.electronAPI.needsDataPathSetup();
      set({ needsDataPathSetup: needsSetup });
    } else {
      const { llmConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig } = get();
      localStorage.setItem(
        'app-settings',
        JSON.stringify({ state: { llmConfig, appConfig, shortcutConfig, roles, activeRoleId, apiProviders, mcpConfig }, version: 0 })
      );
    }
  },

  // ── 智能体管理方法（方法名保留旧名，见接口层 @note 标注） ──

  /**
   * 创建新智能体
   * @param name 智能体名称
   * @param systemPrompt 系统提示词
   * @param llmConfig 可选的 LLM 配置（未提供则使用当前全局配置）
   * @param useCustomConfig 是否使用自定义配置（默认 false）
   * @param mcpConfig 可选的 MCP 配置（未提供则使用当前全局配置作为独立基线）
   * @returns 新智能体的 ID
   */
  createRole: (name, systemPrompt, llmConfig, useCustomConfig = false, mcpConfig) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const currentLLMConfig = get().llmConfig;
    const currentMCPConfig = get().mcpConfig;

    const newRole: Role = {
      id,
      name,
      systemPrompt,
      llmConfig: { ...currentLLMConfig, ...llmConfig },
      useCustomConfig,
      // 从全局 MCP 配置快照作为初始值（除非用户明确传入）
      mcpConfig: mcpConfig ? { ...DEFAULT_MCP_CONFIG, ...mcpConfig } : { ...currentMCPConfig },
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      roles: [...state.roles, newRole],
    }));
    get().saveSettings();
    return id;
  },

  /**
   * 更新智能体
   * @param id 智能体 ID
   * @param patch 要更新的字段（默认智能体的 name/isDefault 不可修改）
   */
  updateRole: (id, patch) => {
    const isDefault = id === DEFAULT_AGENT_ID;
    const safePatch = isDefault
      ? { ...patch, name: undefined, isDefault: undefined }
      : patch;
    set((state) => ({
      roles: state.roles.map((role) =>
        role.id === id
          ? { ...role, ...safePatch, updatedAt: Date.now() }
          : role
      ),
    }));
    get().saveSettings();
  },

  /**
   * 删除智能体（默认智能体不可删除）
   * @param id 智能体 ID
   */
  deleteRole: (id) => {
    if (id === DEFAULT_AGENT_ID) return;
    const { activeRoleId } = get();
    set((state) => ({
      roles: state.roles.filter((role) => role.id !== id),
      // 如果删除的是当前激活智能体，重置为 null
      activeRoleId: activeRoleId === id ? null : activeRoleId,
    }));
    get().saveSettings();
  },

  /**
   * 重新排序智能体（拖拽后调用）
   * @param fromIndex 拖拽起始索引
   * @param toIndex 目标放置索引
   */
  reorderRoles: (fromIndex, toIndex) => {
    set((state) => {
      const newRoles = [...state.roles];
      const [moved] = newRoles.splice(fromIndex, 1);
      newRoles.splice(toIndex, 0, moved);
      return { roles: newRoles };
    });
    get().saveSettings();
  },

  /**
   * 直接设置智能体顺序（Framer Motion Reorder 回调使用）
   * @param orderedAgents 新的智能体排列顺序
   */
  setAgentsOrder: (orderedAgents) => {
    set({ roles: orderedAgents });
    get().saveSettings();
  },

  /**
   * 切换当前激活智能体
   * @param id 智能体 ID（null = 使用全局配置）
   */
  setActiveRole: (id) => {
    set({ activeRoleId: id });
    get().saveSettings();
  },

  /**
   * @deprecated 不再使用。新架构中会话配置已独立，请直接读取 session.llmConfig。
   * 保留此方法仅为向后兼容，实际不应被调用。
   */
  getEffectiveLLMConfig: () => {
    const { activeRoleId, roles, llmConfig, apiProviders } = get();
    const base = (() => {
      if (!activeRoleId) return llmConfig;
      const role = roles.find((r) => r.id === activeRoleId);
      if (!role) return llmConfig;
      return role.useCustomConfig ? role.llmConfig : llmConfig;
    })();
    return resolveConfig(base, apiProviders);
  },

  // ── 服务商管理方法 ────────────────────────────────────────

  addAPIProvider: (provider) => {
    const id = crypto.randomUUID();
    set((state) => ({
      apiProviders: [...state.apiProviders, { ...provider, id }],
    }));
    get().saveSettings();
    return id;
  },

  updateAPIProvider: (id, patch) => {
    set((state) => ({
      apiProviders: state.apiProviders.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    get().saveSettings();
  },

  deleteAPIProvider: (id) => {
    set((state) => {
      const newProviders = state.apiProviders.filter((p) => p.id !== id);
      // 若删除的是当前默认服务商，清除 providerId
      const newLLMConfig =
        state.llmConfig.providerId === id
          ? { ...state.llmConfig, providerId: undefined }
          : state.llmConfig;
      return { apiProviders: newProviders, llmConfig: newLLMConfig };
    });
    get().saveSettings();
  },

  setDefaultProvider: (id) => {
    const { apiProviders, llmConfig } = get();
    const provider = apiProviders.find((p) => p.id === id);
    if (!provider) return;
    // 优先选第一个聊天类激活模型（跳过向量等不适合聊天的模型）
    const allM = getAllModels(provider);
    const firstChatActive = provider.activeModels?.find((modelId) => {
      const info = allM.find((m) => m.id === modelId);
      return !info || info.capabilities.includes('chat');
    });
    const newModel = firstChatActive ?? llmConfig.model;
    set({
      llmConfig: {
        ...llmConfig,
        providerId: id,
        model: newModel,
      },
    });
    get().saveSettings();
  },

  fetchModels: async (providerId) => {
    const { apiProviders } = get();
    const provider = apiProviders.find((p) => p.id === providerId);
    // 检查服务商是否存在且已启用
    if (!provider || !provider.enabled) return;

    // 标记正在加载，清除之前的错误
    set((state) => ({
      fetchingModels: { ...state.fetchingModels, [providerId]: true },
      fetchModelsError: { ...state.fetchModelsError, [providerId]: '' },
    }));
    try {
      const fresh = await fetchProviderModels(provider.baseURL, provider.apiKey);
      const existing = provider.cachedModels ?? [];
      // 保留用户手动修改过能力的条目，其余使用 API 返回的最新数据
      const merged = fresh.map((m) => {
        const prev = existing.find((e) => e.id === m.id);
        return prev?.capabilitiesOverridden ? prev : m;
      });
      // 清理 activeModels 中已失效的模型 ID（API 不再返回的模型）
      const validModelIds = new Set(merged.map((m) => m.id));
      const cleanedActiveModels = (provider.activeModels ?? []).filter((id) => validModelIds.has(id));
      set((state) => ({
        apiProviders: state.apiProviders.map((p) =>
          p.id === providerId
            ? {
                ...p,
                cachedModels: merged,
                activeModels: cleanedActiveModels,
                modelsLastFetched: Date.now(),
              }
            : p
        ),
      }));
      get().saveSettings();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[fetchModels] 获取服务商 "${provider.name}" 模型列表失败:`, errorMsg);
      set((state) => ({
        fetchModelsError: { ...state.fetchModelsError, [providerId]: errorMsg },
      }));
    } finally {
      set((state) => {
        const next = { ...state.fetchingModels };
        delete next[providerId];
        return { fetchingModels: next };
      });
    }
  },

  addCustomModel: (providerId, modelId, capabilities) => {
    const { apiProviders } = get();
    const provider = apiProviders.find((p) => p.id === providerId);
    if (!provider) return;
    // 防止重复添加
    if ((provider.customModels ?? []).some((m) => m.id === modelId)) return;
    const info: ModelInfo = { id: modelId, capabilities: capabilities ?? ['chat'] };
    set({
      apiProviders: apiProviders.map((p) =>
        p.id === providerId
          ? { ...p, customModels: [...(p.customModels ?? []), info] }
          : p
      ),
    });
    get().saveSettings();
  },

  removeCustomModel: (providerId, modelId) => {
    set((state) => ({
      apiProviders: state.apiProviders.map((p) =>
        p.id === providerId
          ? {
              ...p,
              customModels: (p.customModels ?? []).filter((m) => m.id !== modelId),
              // 同时从 activeModels 中移除
              activeModels: (p.activeModels ?? []).filter((id) => id !== modelId),
            }
          : p
      ),
    }));
    get().saveSettings();
  },
})));
