// ============================================================
// Settings 页面
// 提供 LLM 配置、数据路径、键盘快捷键、智能体管理四块设置的 UI
//
// 状态管理策略：
//   - 所有配置项均实时保存到 store，无需点击"保存"按钮
//   - LLM 配置：直接调用 updateLLMConfig
//   - 外观配置：直接调用 updateAppConfig
//   - 快捷键：录制完立即调用 updateShortcutConfig
//   - 智能体管理：CRUD 操作直接调用对应 store 方法
//
// 扩展指南：
//   - 新增配置项：在对应 <div className={styles.field}> 区块内添加新字段
//   - 新增配置分组：复制 <div className={styles.divider}> + 分组 header 的模式
// ============================================================

import { useState, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { mcpRegistry } from '../services/mcp';
import type { ShortcutAction, Role, LLMConfig, APIProvider, ModelCapability, ModelInfo, QuickPhrase, MCPConfig } from '../types';
import { DEFAULT_AGENT_ID, DEFAULT_MCP_CONFIG } from '../types';
import { DEFAULT_SHORTCUTS } from '../types';
import { getAllModels } from '../services/llmUtils';
import Modal from '../components/Modal';
import styles from './Settings.module.css';

// ── 能力标签常量 ─────────────────────────────────────────────

const ALL_CAPABILITIES: ModelCapability[] = ['chat', 'reasoning', 'embedding', 'vision', 'tool-use'];

const CAP_LABELS: Record<ModelCapability, string> = {
  chat: '对话',
  reasoning: '推理',
  embedding: '向量',
  vision: '视觉',
  'tool-use': '工具',
};

const CAP_BADGE_CLASS: Record<ModelCapability, string | undefined> = {
  chat: undefined,
  reasoning: styles.cap_reasoning,
  embedding: styles.cap_embedding,
  vision: styles.cap_vision,
  'tool-use': styles.cap_tool_use,
};

// ── CapabilityBadges 组件 ────────────────────────────────────

function CapabilityBadges({ modelInfo, providerId }: { modelInfo: ModelInfo; providerId: string }) {
  const { updateAPIProvider, apiProviders } = useSettingsStore();
  const [isOpen, setIsOpen] = useState(false);
  const [localRPM, setLocalRPM] = useState(modelInfo.rateLimitPerMinute ?? 0);

  // 当外部 modelInfo 变化时同步本地 RPM 状态
  useEffect(() => {
    setLocalRPM(modelInfo.rateLimitPerMinute ?? 0);
  }, [modelInfo.rateLimitPerMinute]);

  /** 更新当前模型的元数据（customModels 或 cachedModels） */
  const updateModelInfo = (patch: Partial<ModelInfo>) => {
    const provider = apiProviders.find((p) => p.id === providerId);
    if (!provider) return;
    const isCustom = provider.customModels?.some((m) => m.id === modelInfo.id);
    if (isCustom) {
      const newCustomModels = (provider.customModels ?? []).map((m) =>
        m.id === modelInfo.id ? { ...m, ...patch } : m
      );
      updateAPIProvider(providerId, { customModels: newCustomModels });
    } else if (provider.cachedModels) {
      const newCachedModels = provider.cachedModels.map((m) =>
        m.id === modelInfo.id ? { ...m, ...patch } : m
      );
      updateAPIProvider(providerId, { cachedModels: newCachedModels });
    }
  };

  const toggleCap = (cap: ModelCapability) => {
    const provider = apiProviders.find((p) => p.id === providerId);
    if (!provider) return;
    const isCustom = provider.customModels?.some((m) => m.id === modelInfo.id);
    if (isCustom) {
      const newCustomModels = (provider.customModels ?? []).map((m) =>
        m.id === modelInfo.id
          ? {
              ...m,
              capabilitiesOverridden: true,
              capabilities: m.capabilities.includes(cap)
                ? m.capabilities.filter((c) => c !== cap)
                : [...m.capabilities, cap],
            }
          : m
      );
      updateAPIProvider(providerId, { customModels: newCustomModels });
    } else if (provider.cachedModels) {
      const newCachedModels = provider.cachedModels.map((m) =>
        m.id === modelInfo.id
          ? {
              ...m,
              capabilitiesOverridden: true,
              capabilities: m.capabilities.includes(cap)
                ? m.capabilities.filter((c) => c !== cap)
                : [...m.capabilities, cap],
            }
          : m
      );
      updateAPIProvider(providerId, { cachedModels: newCachedModels });
    }
  };

  return (
    <span className={styles.capGroup} onClick={(e) => e.preventDefault()}>
      {modelInfo.capabilities.map((cap) => (
        <span
          key={cap}
          className={`${styles.capBadge}${CAP_BADGE_CLASS[cap] ? ` ${CAP_BADGE_CLASS[cap]}` : ''}`}
        >
          {CAP_LABELS[cap]}
        </span>
      ))}
      {modelInfo.capabilitiesOverridden && (
        <span className={styles.capOverriddenDot} title="已手动修改">*</span>
      )}
      <button
        className={styles.editCapButton}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIsOpen(true); }}
        title="编辑模型"
      >
        ✎
      </button>
      <Modal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title="编辑模型"
        maxWidth="380px"
        footer={
          <button className={styles.saveButton} onClick={() => setIsOpen(false)}>
            完成
          </button>
        }
      >
        <p className={styles.hint} style={{ marginTop: 0 }}>模型：{modelInfo.id}</p>
        <div className={styles.capCheckGroup}>
          {ALL_CAPABILITIES.map((cap) => (
            <label key={cap} className={styles.capCheckLabel}>
              <input
                type="checkbox"
                checked={modelInfo.capabilities.includes(cap)}
                onChange={() => toggleCap(cap)}
              />
              <span className={`${styles.capBadge}${CAP_BADGE_CLASS[cap] ? ` ${CAP_BADGE_CLASS[cap]}` : ''}`}>
                {CAP_LABELS[cap]}
              </span>
            </label>
          ))}
        </div>
        <div className={styles.field} style={{ marginTop: '0.75rem' }}>
          <label className={styles.label}>速率限制（次/分钟）</label>
          <input
            type="number"
            className={styles.input}
            value={localRPM}
            onChange={(e) => setLocalRPM(Math.max(0, parseInt(e.target.value) || 0))}
            onBlur={() => updateModelInfo({ rateLimitPerMinute: localRPM > 0 ? localRPM : undefined })}
            min="0"
            placeholder="0 = 不限"
          />
          <p className={styles.hint}>此模型的每分钟请求上限，0 表示不限制</p>
        </div>
      </Modal>
    </span>
  );
}

/** 操作 ID → 用户可读标签的映射，用于快捷键配置列表展示 */
const ACTION_LABELS: Record<ShortcutAction, string> = {
  editMessage:      '编辑消息',
  deleteMessage:    '删除消息',
  retryMessage:     '重试消息',
  continueFrom:     '继续',
  copyMessage:      '复制消息',
  clearConversation:'清空对话',
};

export default function Settings() {

  // 从全局 store 读取当前配置和更新方法
  const {
    llmConfig,
    appConfig,
    shortcutConfig,
    roles,
    apiProviders,
    fetchingModels,
    fetchModelsError,
    updateLLMConfig,
    updateAppConfig,
    updateShortcutConfig,
    createRole,
    updateRole,
    deleteRole,
    addAPIProvider,
    updateAPIProvider,
    deleteAPIProvider,
    setDefaultProvider,
    fetchModels,
    addCustomModel,
    removeCustomModel,
  } = useSettingsStore();

  // 当前正在录制快捷键的操作名（null = 未录制）
  const [listeningAction, setListeningAction] = useState<ShortcutAction | null>(null);
  // 当前选中的选项卡：'model' | 'appearance' | 'shortcuts' | 'roles' | 'mcp' | 'misc'
  const [activeTab, setActiveTab] = useState<'model' | 'appearance' | 'shortcuts' | 'roles' | 'mcp' | 'misc'>('model');

  // MCP 选项卡：当前正在编辑哪个智能体的 MCP 配置
  const [mcpSelectedRoleId, setMcpSelectedRoleId] = useState<string>('');

  // 当 agents 加载/变化时，确保 mcpSelectedRoleId 始终指向一个有效智能体
  useEffect(() => {
    if (roles.length > 0 && !roles.find(r => r.id === mcpSelectedRoleId)) {
      setMcpSelectedRoleId(roles[0].id);
    }
  }, [roles, mcpSelectedRoleId]);
  // 选中的智能体的 MCP 配置
  const selectedMcpConfig = useMemo(() => {
    const role = roles.find(r => r.id === mcpSelectedRoleId);
    return role?.mcpConfig;
  }, [roles, mcpSelectedRoleId]);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

  // 快捷短语新增表单状态
  const [isAddingPhrase, setIsAddingPhrase] = useState(false);
  const [phraseForm, setPhraseForm] = useState<{ label: string; text: string }>({ label: '', text: '' });
  const [editingPhraseId, setEditingPhraseId] = useState<string | null>(null);

  // 当前正在查看模型列表的服务商 ID（空字符串 = 跟随默认服务商）
  const [selectedModelProviderId, setSelectedModelProviderId] = useState<string>('');

  // 当 apiProviders 变化时，确保 selectedModelProviderId 有效
  useEffect(() => {
    if (selectedModelProviderId && !apiProviders.find(p => p.id === selectedModelProviderId)) {
      setSelectedModelProviderId('');
    }
  }, [apiProviders, selectedModelProviderId]);

  // 服务商表单状态
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [isProviderFormVisible, setIsProviderFormVisible] = useState(false);
  const [providerForm, setProviderForm] = useState<Omit<APIProvider, 'id' | 'cachedModels' | 'activeModels' | 'modelsLastFetched'>>({
    name: '',
    baseURL: '',
    apiKey: '',
    enabled: true,
    rateLimitPerMinute: 0,
  });

  // 自定义模型表单状态
  const [isCustomModelFormVisible, setIsCustomModelFormVisible] = useState(false);
  const [customModelForm, setCustomModelForm] = useState<{ id: string; capabilities: ModelCapability[] }>({
    id: '',
    capabilities: ['chat'],
  });

  /**
   * 打开系统文件夹选择对话框（仅 Electron 可用）
   * 选择结果直接保存到 store
   */
  const handleSelectFolder = async () => {
    if (window.electronAPI) {
      const selectedPath = await window.electronAPI.selectFolder();
      if (selectedPath) {
        updateAppConfig({ dataPath: selectedPath });
      }
    }
  };

  // ── 服务商管理处理函数 ────────────────────────────────────

  const handleNewProvider = () => {
    setEditingProviderId(null);
    setProviderForm({ name: '', baseURL: '', apiKey: '', enabled: true, rateLimitPerMinute: 0 });
    setIsProviderFormVisible(true);
  };

  const handleEditProvider = (provider: APIProvider) => {
    setEditingProviderId(provider.id);
    setProviderForm({ name: provider.name, baseURL: provider.baseURL, apiKey: provider.apiKey, enabled: provider.enabled, rateLimitPerMinute: provider.rateLimitPerMinute ?? 0 });
    setIsProviderFormVisible(true);
  };

  const handleSaveProvider = () => {
    if (!providerForm.name.trim() || !providerForm.baseURL.trim()) return;
    if (editingProviderId) {
      updateAPIProvider(editingProviderId, providerForm);
    } else {
      addAPIProvider({ ...providerForm, cachedModels: [], activeModels: [] });
    }
    setIsProviderFormVisible(false);
    setEditingProviderId(null);
    setProviderForm({ name: '', baseURL: '', apiKey: '', enabled: true, rateLimitPerMinute: 0 });
  };

  const handleCancelProvider = () => {
    setIsProviderFormVisible(false);
    setEditingProviderId(null);
    setProviderForm({ name: '', baseURL: '', apiKey: '', enabled: true, rateLimitPerMinute: 0 });
  };

  // 当前默认服务商
  const defaultProvider = apiProviders.find((p) => p.id === llmConfig.providerId);

  // 自动命名模型选项：遍历所有启用的服务商的聊天模型
  // 值格式："providerId|modelName"，显示格式："服务商名|模型名"
  const autoNameModelOptions: { value: string; label: string }[] = (() => {
    const opts: { value: string; label: string }[] = [];
    for (const p of apiProviders) {
      if (!p.enabled) continue;
      const allModels = getAllModels(p);
      const chatModels = allModels.filter((m) => m.capabilities.includes('chat'));
      for (const m of chatModels) {
        opts.push({ value: `${p.id}|${m.id}`, label: `${p.name}|${m.id}` });
      }
    }
    return opts;
  })();

  // 当前默认服务商的可选模型：优先 activeModels（过滤向量模型），否则从全量模型（cached + custom）中取聊天模型
  const availableModels: string[] = (() => {
    if (!defaultProvider) return [];
    const allModels = getAllModels(defaultProvider);
    const chatActive = (defaultProvider.activeModels ?? []).filter((id) => {
      const info = allModels.find((m) => m.id === id);
      return !info || info.capabilities.includes('chat');
    });
    if (chatActive.length > 0) return chatActive;
    return allModels.filter((m) => m.capabilities.includes('chat')).map((m) => m.id);
  })();

  // 当前在模型列表中选中的服务商（用于查看/管理模型）
  const modelListProvider = selectedModelProviderId
    ? apiProviders.find((p) => p.id === selectedModelProviderId)
    : defaultProvider;

  // ── 智能体管理处理函数 ──────────────────────────────────
  // 注：以下 createRole/updateRole/deleteRole 等 store 方法名保留旧名，
  //     避免大规模重命名引发热更新崩溃。语义上均指 Agent 操作。

  /** 新建智能体：立即创建并实时编辑 */
  const handleNewRole = () => {
    const newId = createRole('新智能体', '');
    setEditingRoleId(newId);
  };

  /** 编辑已有智能体 */
  const handleEditRole = (role: Role) => {
    setEditingRoleId(role.id);
  };





  /**
   * 快捷键录制：监听 keydown 事件，捕获用户按下的组合键
   *
   * 触发条件：listeningAction 非 null
   * 特殊处理：
   *   - Escape → 取消录制（不保存）
   *   - 单独按修饰键（Ctrl/Shift/Alt/Meta）→ 忽略，等待完整组合
   * 捕获阶段（第三个参数 true）：确保在其他 handler 之前捕获事件
   */
  useEffect(() => {
    if (!listeningAction) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // IME 组合输入期间忽略，避免捕获拼音中间状态
      if (e.isComposing) return;

      // Escape：取消录制
      if (e.key === 'Escape') {
        setListeningAction(null);
        return;
      }

      // 构建绑定字符串，格式：[Ctrl+][Shift+][Alt+][Meta+]Key
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Meta');

      // 忽略仅按修饰键的情况（避免生成 "Ctrl" 这样不完整的绑定）
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      // 使用 e.code 提取物理键名，避免 macOS 上 Option+t → '†' 等跨平台差异
      // e.code 是物理键位标识（如 'KeyT'），不随修饰键/键盘布局变化
      const keyName = e.code.startsWith('Key')
        ? e.code.slice(3).toLowerCase()       // KeyT → t
        : e.code.startsWith('Digit')
          ? e.code.slice(5)                    // Digit1 → 1
          : e.key;                             // F2 / Escape / Backspace 等
      parts.push(keyName);
      const binding = parts.join('+');

      // 实时写入 store，快捷键立即生效（不需要点保存）
      updateShortcutConfig({ [listeningAction]: [binding] });
      setListeningAction(null);
    };

    // 使用捕获阶段，防止被其他事件监听器拦截
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [listeningAction, updateShortcutConfig]);

  return (
    <div className={styles.container}>
      <div className={`${styles.card} ${activeTab === 'roles' ? styles.cardWide : ''}`}>
        <h1 className={styles.title}>设置</h1>

        {/* ── 选项卡导航 ──────────────────────────────────── */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'model' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('model')}
          >
            模型配置
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'appearance' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            外观
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'shortcuts' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('shortcuts')}
          >
            快捷键
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'roles' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('roles')}
          >
            智能体
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'mcp' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('mcp')}
          >
            MCP
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'misc' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('misc')}
          >
            杂项
          </button>
        </div>

        <div className={styles.form}>
          {/* ── 模型配置选项卡 ──────────────────────────────── */}
          {activeTab === 'model' && (
            <>
              {/* 服务商列表 */}
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>API 服务商</span>
                <button className={styles.newRoleButton} onClick={handleNewProvider}>
                  + 添加服务商
                </button>
              </div>

              {apiProviders.length === 0 ? (
                <div className={styles.emptyHint}>暂无服务商，点击"添加服务商"创建</div>
              ) : (
                <div className={styles.providerList}>
                  {apiProviders.map((provider) => {
                    const isSelected = provider.id === (modelListProvider?.id ?? '');
                    return (
                      <div
                        key={provider.id}
                        className={`${styles.providerItem}${isSelected ? ` ${styles.providerItemActive}` : ''}`}
                        onClick={() => setSelectedModelProviderId(provider.id)}
                      >
                        <div className={styles.providerItemMain}>
                          <div className={styles.providerItemHeader}>
                            <span className={styles.providerName}>{provider.name}</span>
                            {provider.id === llmConfig.providerId && (
                              <span className={styles.defaultBadge}>默认</span>
                            )}
                          </div>
                          <span className={styles.providerUrl}>{provider.baseURL}</span>
                        </div>
                        <div className={styles.providerItemActions}>
                          <label className={styles.toggleLabel} title={provider.enabled ? '已启用' : '已禁用'} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={provider.enabled}
                              onChange={(e) => updateAPIProvider(provider.id, { enabled: e.target.checked })}
                            />
                            <span className={styles.toggleText}>{provider.enabled ? '启用' : '禁用'}</span>
                          </label>
                          {provider.id !== llmConfig.providerId && (
                            <button
                              className={styles.setDefaultButton}
                              onClick={(e) => { e.stopPropagation(); setDefaultProvider(provider.id); }}
                            >
                              设为默认
                            </button>
                          )}
                          <button
                            className={styles.roleActionButton}
                            onClick={(e) => { e.stopPropagation(); handleEditProvider(provider); }}
                            title="编辑"
                          >
                            ✎
                          </button>
                          <button
                            className={styles.roleActionButton}
                            onClick={(e) => { e.stopPropagation(); deleteAPIProvider(provider.id); }}
                            title="删除"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 服务商添加/编辑表单 */}
              {isProviderFormVisible && (
                <div className={styles.providerForm}>
                  <div className={styles.sectionTitle}>
                    {editingProviderId ? '编辑服务商' : '添加服务商'}
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>名称</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={providerForm.name}
                      onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                      placeholder="例如：OpenAI、DeepSeek"
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>API 端点</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={providerForm.baseURL}
                      onChange={(e) => setProviderForm({ ...providerForm, baseURL: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>API 密钥</label>
                    <input
                      type="password"
                      className={styles.input}
                      value={providerForm.apiKey}
                      onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                    <p className={styles.hint}>⚠️ 密钥将存储在本地，请确保使用受限密钥</p>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>速率限制 — 服务商（次/分钟）</label>
                    <input
                      type="number"
                      className={styles.input}
                      value={providerForm.rateLimitPerMinute ?? 0}
                      onChange={(e) => setProviderForm({ ...providerForm, rateLimitPerMinute: Math.max(0, parseInt(e.target.value) || 0) })}
                      min="0"
                      placeholder="0 = 不限"
                    />
                    <p className={styles.hint}>此服务商下所有模型共享的每分钟请求上限，0 表示不限制</p>
                  </div>
                  <div className={styles.roleFormButtons}>
                    <button
                      className={styles.saveButton}
                      onClick={handleSaveProvider}
                      disabled={!providerForm.name.trim() || !providerForm.baseURL.trim()}
                    >
                      保存
                    </button>
                    <button className={styles.cancelButton} onClick={handleCancelProvider}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              <div className={styles.divider} />

              {/* 模型列表（点击服务商行切换） */}
              {apiProviders.length > 0 && (
                <>
                  {modelListProvider && (
                    <>
                      <div className={styles.sectionHeader}>
                        <span className={styles.sectionTitle}>
                          模型列表 — {modelListProvider.name}
                        </span>
                        <div className={styles.sectionHeaderActions}>
                          <button
                            className={styles.fetchModelsButton}
                            onClick={() => fetchModels(modelListProvider.id)}
                            disabled={fetchingModels[modelListProvider.id]}
                          >
                            {fetchingModels[modelListProvider.id] ? '获取中…' : '获取模型列表'}
                          </button>
                          <button
                            className={styles.addCustomModelButton}
                            onClick={() => {
                              setIsCustomModelFormVisible(true);
                              setCustomModelForm({ id: '', capabilities: ['chat'] });
                            }}
                            title="手动添加模型（用于 API 不兼容或无法自动获取的情况）"
                          >
                            + 自定义模型
                          </button>
                        </div>
                      </div>
                      {fetchModelsError[modelListProvider.id] && (
                        <div className={styles.fetchError}>
                          ❌ {fetchModelsError[modelListProvider.id]}
                        </div>
                      )}

                      {/* 自定义模型添加弹窗 */}
                      <Modal
                        open={isCustomModelFormVisible}
                        onClose={() => {
                          setIsCustomModelFormVisible(false);
                          setCustomModelForm({ id: '', capabilities: ['chat'] });
                        }}
                        title="添加自定义模型"
                        maxWidth="440px"
                        footer={
                          <>
                            <button
                              className={styles.cancelButton}
                              onClick={() => {
                                setIsCustomModelFormVisible(false);
                                setCustomModelForm({ id: '', capabilities: ['chat'] });
                              }}
                            >
                              取消
                            </button>
                            <button
                              className={styles.saveButton}
                              onClick={() => {
                                if (!customModelForm.id.trim()) return;
                                addCustomModel(modelListProvider.id, customModelForm.id.trim(), customModelForm.capabilities);
                                setIsCustomModelFormVisible(false);
                                setCustomModelForm({ id: '', capabilities: ['chat'] });
                              }}
                              disabled={!customModelForm.id.trim()}
                            >
                              添加
                            </button>
                          </>
                        }
                      >
                        <div className={styles.field}>
                          <label className={styles.label}>模型 ID</label>
                          <input
                            type="text"
                            className={styles.input}
                            value={customModelForm.id}
                            onChange={(e) => setCustomModelForm({ ...customModelForm, id: e.target.value })}
                            placeholder="例如：gpt-4、claude-3-opus"
                          />
                        </div>
                        <div className={styles.field}>
                          <label className={styles.label}>能力标签</label>
                          <div className={styles.capCheckGroup}>
                            {ALL_CAPABILITIES.map((cap) => (
                              <label key={cap} className={styles.capCheckLabel}>
                                <input
                                  type="checkbox"
                                  checked={customModelForm.capabilities.includes(cap)}
                                  onChange={() => {
                                    setCustomModelForm((prev) => ({
                                      ...prev,
                                      capabilities: prev.capabilities.includes(cap)
                                        ? prev.capabilities.filter((c) => c !== cap)
                                        : [...prev.capabilities, cap],
                                    }));
                                  }}
                                />
                                <span className={`${styles.capBadge}${CAP_BADGE_CLASS[cap] ? ` ${CAP_BADGE_CLASS[cap]}` : ''}`}>
                                  {CAP_LABELS[cap]}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </Modal>

                      {(() => {
                        const allModels = getAllModels(modelListProvider);
                        return allModels.length > 0 ? (
                          <div className={styles.modelCheckList}>
                            {allModels.map((modelInfo) => {
                              const isActive = modelListProvider.activeModels?.includes(modelInfo.id) ?? false;
                              const isCustom = modelListProvider.customModels?.some((m) => m.id === modelInfo.id) ?? false;
                              return (
                                <div
                                  key={modelInfo.id}
                                  className={`${styles.modelCheckItem}${isActive ? ` ${styles.modelCheckItemActive}` : ''}`}
                                  onClick={() => {
                                    const prev = modelListProvider.activeModels ?? [];
                                    const next = isActive
                                      ? prev.filter((m) => m !== modelInfo.id)
                                      : [...prev, modelInfo.id];
                                    updateAPIProvider(modelListProvider.id, { activeModels: next });
                                  }}
                                >
                                  <span>{modelInfo.id}</span>
                                  <span className={styles.modelItemRight}>
                                    {isCustom && (
                                      <span className={styles.customModelTag} title="手动添加的自定义模型">自定义</span>
                                    )}
                                    <CapabilityBadges modelInfo={modelInfo} providerId={modelListProvider.id} />
                                    {isCustom && (
                                      <button
                                        className={styles.deleteCustomModelButton}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          removeCustomModel(modelListProvider.id, modelInfo.id);
                                        }}
                                        title="删除此自定义模型"
                                      >
                                        ×
                                      </button>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className={styles.hint}>
                            {fetchingModels[modelListProvider.id]
                              ? '正在获取模型列表…'
                              : '点击"获取模型列表"从 API 拉取可用模型，或点击"+ 自定义模型"手动添加'}
                          </p>
                        );
                      })()}
                    </>
                  )}
                </>
              )}

              <div className={styles.divider} />

              {/* ── 以下配置仅作为创建新智能体时的初始模板 ── */}
              <div className={styles.sectionTitle}>默认 AI 配置</div>
              <div className={styles.hint} style={{ marginBottom: '0.75rem', marginTop: '-0.25rem' }}>
                此配置仅作为<b>创建新智能体时的初始值</b>，修改不会影响已有智能体和对话。每个智能体和对话可独立调整自己的配置。
              </div>

              {/* 默认模型选择 */}
              <div className={styles.field}>
                <label className={styles.label}>默认模型</label>
                {availableModels.length > 0 ? (
                  <select
                    className={styles.input}
                    value={llmConfig.model}
                    onChange={(e) => updateLLMConfig({ model: e.target.value })}
                  >
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={llmConfig.model}
                    onChange={(e) => updateLLMConfig({ model: e.target.value })}
                    className={styles.input}
                    placeholder="gpt-4"
                  />
                )}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Temperature</label>
                <div className={styles.sliderRow}>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={llmConfig.temperature ?? 0.7}
                    onChange={(e) => updateLLMConfig({ temperature: parseFloat(e.target.value) })}
                    className={styles.slider}
                  />
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={(llmConfig.temperature ?? 0.7).toFixed(1)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) updateLLMConfig({ temperature: Math.min(2, Math.max(0, v)) });
                    }}
                    className={styles.sliderInput}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>最大 Tokens</label>
                <input
                  type="number"
                  value={llmConfig.maxTokens ?? ''}
                  onChange={(e) => updateLLMConfig({ maxTokens: e.target.value === '' ? undefined : parseInt(e.target.value) || undefined })}
                  className={styles.input}
                  placeholder="不设置（使用模型默认值）"
                  min="1"
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Top K</label>
                <input
                  type="number"
                  value={llmConfig.topK ?? ''}
                  onChange={(e) => updateLLMConfig({ topK: e.target.value === '' ? undefined : parseInt(e.target.value) || undefined })}
                  className={styles.input}
                  placeholder="不设置（使用模型默认值）"
                  min="1"
                />
              </div>

            </>
          )}

          {/* ── 外观选项卡 ──────────────────────────────────── */}
          {activeTab === 'appearance' && (
            <>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>外观配置</span>
                <button
                  className={styles.resetShortcuts}
                  onClick={() => updateAppConfig({ fontSize: 14, lineHeight: 1.6, paragraphSpacing: 0.2 })}
                >
                  恢复默认
                </button>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>字号</label>
                <div className={styles.sliderRow}>
                  <input
                    type="range"
                    min="10"
                    max="22"
                    step="1"
                    value={appConfig.fontSize}
                    onChange={(e) => updateAppConfig({ fontSize: Number(e.target.value) })}
                    className={styles.slider}
                  />
                  <input
                    type="number"
                    min="10"
                    max="22"
                    step="1"
                    value={appConfig.fontSize}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (!isNaN(v)) updateAppConfig({ fontSize: Math.min(22, Math.max(10, v)) });
                    }}
                    className={styles.sliderInput}
                  />
                  <span className={styles.sliderUnit}>px</span>
                </div>
                <div className={styles.sliderTicks}>
                  <span>10</span><span>13</span><span>16</span><span>19</span><span>22</span>
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>行距</label>
                <div className={styles.sliderRow}>
                  <input
                    type="range"
                    min="1.0"
                    max="2.2"
                    step="0.05"
                    value={appConfig.lineHeight}
                    onChange={(e) => updateAppConfig({ lineHeight: Number(e.target.value) })}
                    className={styles.slider}
                  />
                  <input
                    type="number"
                    min="1.0"
                    max="2.2"
                    step="0.05"
                    value={appConfig.lineHeight.toFixed(2)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) updateAppConfig({ lineHeight: Math.min(2.2, Math.max(1.0, v)) });
                    }}
                    className={styles.sliderInput}
                  />
                </div>
                <div className={styles.sliderTicks}>
                  <span>1.0</span><span>1.4</span><span>1.8</span><span>2.2</span>
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>段间距</label>
                <div className={styles.sliderRow}>
                  <input
                    type="range"
                    min="0"
                    max="1.0"
                    step="0.05"
                    value={appConfig.paragraphSpacing}
                    onChange={(e) => updateAppConfig({ paragraphSpacing: Number(e.target.value) })}
                    className={styles.slider}
                  />
                  <input
                    type="number"
                    min="0"
                    max="1.0"
                    step="0.05"
                    value={appConfig.paragraphSpacing.toFixed(2)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) updateAppConfig({ paragraphSpacing: Math.min(1.0, Math.max(0, v)) });
                    }}
                    className={styles.sliderInput}
                  />
                  <span className={styles.sliderUnit}>em</span>
                </div>
                <div className={styles.sliderTicks}>
                  <span>0</span><span>0.25</span><span>0.5</span><span>0.75</span><span>1.0</span>
                </div>
              </div>

              <div
                className={styles.previewBox}
                style={{
                  fontSize: appConfig.fontSize,
                  lineHeight: appConfig.lineHeight,
                  '--p-spacing': `${appConfig.paragraphSpacing}em`,
                } as React.CSSProperties}
              >
                <p>行距预览：这是一段较长的示例文字，通过将内容铺满多行来展示行距效果。调整行距时，观察这段文字中每行之间的间隔变化。行距越大，行与行之间越疏朗。</p>
                <p>段间距预览：以上是第一段，这里是第二段。两段之间的间隔由段间距控制，与段内行距无关。</p>
              </div>
            </>
          )}

          {/* ── 快捷键选项卡 ────────────────────────────────── */}
          {activeTab === 'shortcuts' && (
            <>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>快捷键配置</span>
                <button
                  className={styles.resetShortcuts}
                  onClick={() => updateShortcutConfig(DEFAULT_SHORTCUTS)}
                >
                  重置为默认
                </button>
              </div>

              {(Object.keys(shortcutConfig) as ShortcutAction[]).map((action) => (
                <div key={action} className={styles.shortcutRow}>
                  <span className={styles.shortcutLabel}>{ACTION_LABELS[action]}</span>
                  <button
                    className={`${styles.shortcutBadge} ${listeningAction === action ? styles.listening : ''}`}
                    onClick={() =>
                      setListeningAction(listeningAction === action ? null : action)
                    }
                  >
                    {listeningAction === action
                      ? '按下快捷键...'
                      : Array.isArray(shortcutConfig[action])
                        ? shortcutConfig[action].join(' / ')
                        : DEFAULT_SHORTCUTS[action].join(' / ')}
                  </button>
                </div>
              ))}
            </>
          )}

          {/* ── 智能体选项卡 ────────────────────────────────── */}
          {activeTab === 'roles' && (
            <div className={styles.rolesContainer}>
              {/* 左侧：智能体列表 */}
              <div className={styles.rolesList}>
                <div className={styles.rolesHeader}>
                  <span className={styles.sectionTitle}>智能体列表</span>
                  <button className={styles.newRoleButton} onClick={handleNewRole}>
                    + 新建智能体
                  </button>
                </div>

                {roles.map((role) => (
                  <div
                    key={role.id}
                    className={`${styles.roleItem} ${editingRoleId === role.id ? styles.roleItemActive : ''}`}
                    onClick={() => handleEditRole(role)}
                  >
                    <div className={styles.roleItemContent}>
                      <span className={styles.roleName}>{role.name}</span>
                      {role.id === DEFAULT_AGENT_ID && (
                        <span className={styles.defaultBadge}>默认</span>
                      )}
                    </div>
                    <div className={styles.roleItemActions}>
                      <button
                        className={styles.roleActionButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          role.id !== DEFAULT_AGENT_ID && deleteRole(role.id);
                        }}
                        title={role.id === DEFAULT_AGENT_ID ? '默认智能体不可删除' : '删除'}
                        disabled={role.id === DEFAULT_AGENT_ID}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 右侧：编辑表单 */}
              <div className={styles.roleForm}>
                {!editingRoleId ? (
                  <div className={styles.emptyFormHint}>
                    <p>← 点击左侧"新建智能体"或选择一个智能体进行编辑</p>
                  </div>
                ) : (
                  <>
                    <div className={styles.sectionTitle}>智能体编辑</div>

                    <div className={styles.field}>
                      <label className={styles.label}>智能体名称</label>
                      <input
                        type="text"
                        className={styles.input}
                        value={roles.find(r => r.id === editingRoleId)?.name ?? ''}
                        onChange={(e) => updateRole(editingRoleId!, { name: e.target.value })}
                        placeholder="例如：代码助手、翻译官"
                        readOnly={editingRoleId === DEFAULT_AGENT_ID}
                        title={editingRoleId === DEFAULT_AGENT_ID ? '默认智能体名称不可修改' : undefined}
                        style={editingRoleId === DEFAULT_AGENT_ID ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                      />
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>系统提示词</label>
                      <textarea
                        className={styles.textarea}
                        value={roles.find(r => r.id === editingRoleId)?.systemPrompt ?? ''}
                        onChange={(e) => updateRole(editingRoleId!, { systemPrompt: e.target.value })}
                        placeholder="定义智能体的行为和特性，例如：你是一个专业的代码助手..."
                        rows={8}
                      />
                    </div>

                    {/* 快捷短语管理 */}
                    {editingRoleId && (() => {
                      const currentRole = roles.find((r) => r.id === editingRoleId);
                      const phrases: QuickPhrase[] = currentRole?.quickPhrases ?? [];

                      const savePhrase = () => {
                        if (!phraseForm.label.trim() || !phraseForm.text.trim()) return;
                        if (editingPhraseId) {
                          updateRole(editingRoleId, {
                            quickPhrases: phrases.map((p) =>
                              p.id === editingPhraseId
                                ? { ...p, label: phraseForm.label.trim(), text: phraseForm.text.trim() }
                                : p
                            ),
                          });
                          setEditingPhraseId(null);
                        } else {
                          updateRole(editingRoleId, {
                            quickPhrases: [...phrases, { id: crypto.randomUUID(), label: phraseForm.label.trim(), text: phraseForm.text.trim() }],
                          });
                          setIsAddingPhrase(false);
                        }
                        setPhraseForm({ label: '', text: '' });
                      };

                      const cancelPhrase = () => {
                        setIsAddingPhrase(false);
                        setEditingPhraseId(null);
                        setPhraseForm({ label: '', text: '' });
                      };

                      const startEditPhrase = (p: QuickPhrase) => {
                        setEditingPhraseId(p.id);
                        setIsAddingPhrase(false);
                        setPhraseForm({ label: p.label, text: p.text });
                      };

                      const deletePhrase = (id: string) => {
                        updateRole(editingRoleId, { quickPhrases: phrases.filter((p) => p.id !== id) });
                        if (editingPhraseId === id) cancelPhrase();
                      };

                      const isEditing = isAddingPhrase || editingPhraseId !== null;

                      return (
                        <div className={styles.field}>
                          <div className={styles.quickPhrasesHeader}>
                            <label className={styles.label}>快捷短语</label>
                            {!isEditing && (
                              <button
                                className={styles.quickPhrasesAddBtn}
                                onClick={() => { setIsAddingPhrase(true); setPhraseForm({ label: '', text: '' }); }}
                              >
                                + 新增
                              </button>
                            )}
                          </div>

                          {/* 短语列表 */}
                          {phrases.length === 0 && !isEditing && (
                            <div className={styles.quickPhrasesEmpty}>暂无快捷短语，点击「+ 新增」添加</div>
                          )}
                          {phrases.map((p) => (
                            editingPhraseId === p.id ? (
                              /* 内联编辑表单 */
                              <div key={p.id} className={styles.quickPhraseForm}>
                                <input
                                  className={styles.input}
                                  placeholder="名称（如：转md中文）"
                                  value={phraseForm.label}
                                  onChange={(e) => setPhraseForm({ ...phraseForm, label: e.target.value })}
                                />
                                <textarea
                                  className={styles.textarea}
                                  placeholder="短语内容"
                                  value={phraseForm.text}
                                  onChange={(e) => setPhraseForm({ ...phraseForm, text: e.target.value })}
                                  rows={3}
                                />
                                <div className={styles.quickPhraseFormActions}>
                                  <button className={styles.saveBtn} onClick={savePhrase}>保存</button>
                                  <button className={styles.cancelBtn} onClick={cancelPhrase}>取消</button>
                                </div>
                              </div>
                            ) : (
                              /* 短语展示行 */
                              <div key={p.id} className={styles.quickPhraseItem}>
                                <div className={styles.quickPhraseItemContent}>
                                  <span className={styles.quickPhraseLabel}>{p.label}</span>
                                  <span className={styles.quickPhraseText}>{p.text}</span>
                                </div>
                                {!isEditing && (
                                  <div className={styles.quickPhraseItemActions}>
                                    <button className={styles.quickPhraseEditBtn} onClick={() => startEditPhrase(p)}>编辑</button>
                                    <button className={styles.quickPhraseDeleteBtn} onClick={() => deletePhrase(p.id)}>删除</button>
                                  </div>
                                )}
                              </div>
                            )
                          ))}

                          {/* 新增表单 */}
                          {isAddingPhrase && (
                            <div className={styles.quickPhraseForm}>
                              <input
                                className={styles.input}
                                placeholder="名称（如：转md中文）"
                                value={phraseForm.label}
                                onChange={(e) => setPhraseForm({ ...phraseForm, label: e.target.value })}
                              />
                              <textarea
                                className={styles.textarea}
                                placeholder="短语内容（如：给出以上内容的md格式中文版）"
                                value={phraseForm.text}
                                onChange={(e) => setPhraseForm({ ...phraseForm, text: e.target.value })}
                                rows={3}
                              />
                              <div className={styles.quickPhraseFormActions}>
                                <button className={styles.saveBtn} onClick={savePhrase}>保存</button>
                                <button className={styles.cancelBtn} onClick={cancelPhrase}>取消</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* ── 以下配置仅作为新对话的初始模板 ── */}
                    <div className={styles.divider} />
                    <div className={styles.sectionTitle}>AI 与工具配置</div>
                    <div className={styles.hint} style={{ marginBottom: '0.5rem', marginTop: '-0.25rem' }}>
                      以下配置仅作为<b>创建新对话时的初始值</b>，修改不会影响已有对话。每个对话可独立调整自己的模型、参数和 MCP 权限。
                    </div>

                    {/* 服务商选择 */}
                    <div className={styles.field}>
                      <label className={styles.label}>服务商</label>
                      <select
                        className={styles.input}
                        value={roles.find(r => r.id === editingRoleId)?.llmConfig.providerId ?? ''}
                        onChange={(e) => {
                          const pid = e.target.value;
                          const p = apiProviders.find((ap) => ap.id === pid);
                          const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                          updateRole(editingRoleId!, {
                            llmConfig: {
                              ...currentLlmConfig!,
                              providerId: pid || undefined,
                              model: (() => {
                                const allM = getAllModels(p);
                                const chatActive = p?.activeModels?.find((id) => {
                                  const info = allM.find((m) => m.id === id);
                                  return !info || info.capabilities.includes('chat');
                                });
                                return chatActive ?? allM.filter((m) => m.capabilities.includes('chat')).map((m) => m.id)[0] ?? currentLlmConfig?.model;
                              })(),
                            },
                          });
                        }}
                      >
                        <option value="">— 选择服务商 —</option>
                        {apiProviders.filter((p) => p.enabled).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* 模型选择 */}
                    <div className={styles.field}>
                      <label className={styles.label}>模型</label>
                      {(() => {
                        const editingRole = roles.find(r => r.id === editingRoleId);
                        const rp = apiProviders.find((p) => p.id === editingRole?.llmConfig.providerId);
                        const allM = getAllModels(rp);
                        const chatActive = (rp?.activeModels ?? []).filter((id) => {
                          const info = allM.find((m) => m.id === id);
                          return !info || info.capabilities.includes('chat');
                        });
                        const roleModels = chatActive.length > 0
                          ? chatActive
                          : allM.filter((m) => m.capabilities.includes('chat')).map((m) => m.id);
                        return roleModels.length > 0 ? (
                          <select
                            className={styles.input}
                            value={editingRole?.llmConfig.model ?? ''}
                            onChange={(e) => {
                              const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                              updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, model: e.target.value } });
                            }}
                          >
                            {roleModels.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            className={styles.input}
                            value={editingRole?.llmConfig.model ?? ''}
                            onChange={(e) => {
                              const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                              updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, model: e.target.value } });
                            }}
                            placeholder="gpt-4"
                          />
                        );
                      })()}
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>Temperature</label>
                      <div className={styles.sliderRow}>
                        <input
                          type="range"
                          className={styles.slider}
                          min="0"
                          max="2"
                          step="0.1"
                          value={roles.find(r => r.id === editingRoleId)?.llmConfig.temperature ?? 0.7}
                          onChange={(e) => {
                            const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                            updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, temperature: parseFloat(e.target.value) } });
                          }}
                        />
                        <input
                          type="number"
                          min="0"
                          max="2"
                          step="0.1"
                          value={(roles.find(r => r.id === editingRoleId)?.llmConfig.temperature ?? 0.7).toFixed(1)}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) {
                              const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                              updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, temperature: Math.min(2, Math.max(0, v)) } });
                            }
                          }}
                          className={styles.sliderInput}
                        />
                      </div>
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>最大 Tokens</label>
                      <input
                        type="number"
                        className={styles.input}
                        value={roles.find(r => r.id === editingRoleId)?.llmConfig.maxTokens ?? ''}
                        onChange={(e) => {
                          const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                          updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, maxTokens: e.target.value === '' ? undefined : parseInt(e.target.value) || undefined } });
                        }}
                        placeholder="不设置（使用模型默认值）"
                        min="1"
                      />
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>Top K</label>
                      <input
                        type="number"
                        className={styles.input}
                        value={roles.find(r => r.id === editingRoleId)?.llmConfig.topK ?? ''}
                        onChange={(e) => {
                          const currentLlmConfig = roles.find(r => r.id === editingRoleId)?.llmConfig;
                          updateRole(editingRoleId!, { llmConfig: { ...currentLlmConfig!, topK: e.target.value === '' ? undefined : parseInt(e.target.value) || undefined } });
                        }}
                        placeholder="不设置（使用模型默认值）"
                        min="1"
                      />
                    </div>

                    {/* MCP 工具权限 */}
                    <div className={styles.field}>
                      <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={roles.find(r => r.id === editingRoleId)?.mcpConfig.allowRead ?? false}
                          onChange={(e) => {
                            const currentMcpConfig = roles.find(r => r.id === editingRoleId)?.mcpConfig;
                            updateRole(editingRoleId!, { mcpConfig: { ...currentMcpConfig!, allowRead: e.target.checked } });
                          }}
                        />
                        允许读取文件 / 列目录
                      </label>
                      <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.375rem' }}>
                        <input
                          type="checkbox"
                          checked={roles.find(r => r.id === editingRoleId)?.mcpConfig.allowWrite ?? false}
                          onChange={(e) => {
                            const currentMcpConfig = roles.find(r => r.id === editingRoleId)?.mcpConfig;
                            updateRole(editingRoleId!, { mcpConfig: { ...currentMcpConfig!, allowWrite: e.target.checked } });
                          }}
                        />
                        允许写入文件
                      </label>
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>允许访问的目录</label>
                      <div className={styles.hint} style={{ marginBottom: '0.375rem', marginTop: 0 }}>
                        留空表示拒绝所有路径访问。请添加允许访问的目录以启用文件功能。
                      </div>
                      {(() => {
                        const editingRole = roles.find(r => r.id === editingRoleId);
                        const allowedDirs = editingRole?.mcpConfig.allowedDirs ?? [];
                        return allowedDirs.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.375rem' }}>
                          {allowedDirs.map((dir, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                              <code style={{ flex: 1, fontSize: '0.75rem', background: '#f3f4f6', padding: '0.2rem 0.375rem', borderRadius: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {dir}
                              </code>
                              <button
                                className={styles.cancelButton}
                                style={{ fontSize: '0.75rem', padding: '0.125rem 0.375rem' }}
                                onClick={() => {
                                  const currentMcpConfig = roles.find(r => r.id === editingRoleId)?.mcpConfig;
                                  updateRole(editingRoleId!, { mcpConfig: { ...currentMcpConfig!, allowedDirs: currentMcpConfig!.allowedDirs.filter((_, idx) => idx !== i) } });
                                }}
                                title="删除"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                        ) : (
                        <div className={styles.hint} style={{ marginBottom: '0.375rem' }}>（未配置目录，文件功能不可用）</div>
                        );
                      })()}
                      {window.electronAPI ? (
                        <button
                          className={styles.newRoleButton}
                          onClick={async () => {
                            const folder = await window.electronAPI!.selectFolder();
                            if (folder) {
                              const currentMcpConfig = roles.find(r => r.id === editingRoleId)?.mcpConfig;
                              updateRole(editingRoleId!, { mcpConfig: { ...currentMcpConfig!, allowedDirs: [...currentMcpConfig!.allowedDirs, folder] } });
                            }
                          }}
                        >
                          + 添加目录
                        </button>
                      ) : (
                        <div className={styles.hint}>文件工具仅在桌面端（Electron）可用</div>
                      )}
                    </div>

                  </>
                )}
              </div>
            </div>
          )}

          {/* ── 杂项选项卡 ───────────────────────────────────── */}
          {activeTab === 'misc' && (
            <>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>自动命名</span>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>自动命名使用的模型</label>
                {autoNameModelOptions.length > 0 ? (
                  <select
                    className={styles.input}
                    value={appConfig.autoNamingModel}
                    onChange={(e) => updateAppConfig({ autoNamingModel: e.target.value })}
                  >
                    <option value="">（使用默认模型 — {llmConfig.model}）</option>
                    {autoNameModelOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className={styles.input}
                    value={appConfig.autoNamingModel}
                    onChange={(e) => updateAppConfig({ autoNamingModel: e.target.value })}
                    placeholder={`留空则使用默认模型（${llmConfig.model}）。也可手动输入"服务商ID|模型名"`}
                  />
                )}
                <p className={styles.hint}>
                  创建新会话时，系统会使用此模型自动生成标题。留空则使用"模型配置"中的默认模型。
                </p>
              </div>

              <div className={styles.divider} />

              <div className={styles.field}>
                <label className={styles.label}>数据存储路径</label>
                <div className={styles.pathInput}>
                  <input
                    type="text"
                    value={appConfig.dataPath}
                    onChange={(e) => updateAppConfig({ dataPath: e.target.value })}
                    className={styles.input}
                    placeholder=".data"
                    readOnly={!!window.electronAPI}
                  />
                  {window.electronAPI && (
                    <button onClick={handleSelectFolder} className={styles.browseButton}>
                      浏览...
                    </button>
                  )}
                </div>
                <p className={styles.hint}>
                  {window.electronAPI
                    ? '💾 数据将存储在指定文件夹中（settings.json, chat-history.json）'
                    : '💾 浏览器环境下数据存储在 localStorage 中'}
                </p>
              </div>
            </>
          )}

          {/* ── MCP 选项卡 ─────────────────────────────────────── */}
          {activeTab === 'mcp' && (
            <>
              {/* 智能体选择器 */}
              <div className={styles.field}>
                <label className={styles.label}>选择智能体</label>
                <select
                  className={styles.input}
                  value={mcpSelectedRoleId}
                  onChange={(e) => setMcpSelectedRoleId(e.target.value)}
                >
                  {roles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.isDefault ? '（默认）' : ''}</option>
                  ))}
                </select>
                <div className={styles.hint}>为每个智能体独立配置 MCP 工具权限</div>
              </div>

              <div className={styles.divider} />

              <div className={styles.field}>
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={selectedMcpConfig.enabled}
                    onChange={(e) => {
                      if (!mcpSelectedRoleId) return;
                      updateRole(mcpSelectedRoleId, { mcpConfig: { ...selectedMcpConfig, enabled: e.target.checked } });
                    }}
                    style={{ marginRight: '0.5rem' }}
                  />
                  启用 MCP 工具调用
                </label>
                <div className={styles.hint}>启用后，支持 Function Calling 的模型可以调用文件读写工具</div>
              </div>

              {selectedMcpConfig.enabled && (
                <>
                  <div className={styles.divider} />
                  <div className={styles.sectionTitle}>权限</div>
                  <div className={styles.field}>
                    <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedMcpConfig.allowRead}
                        onChange={(e) => {
                          if (!mcpSelectedRoleId) return;
                          updateRole(mcpSelectedRoleId, { mcpConfig: { ...selectedMcpConfig, allowRead: e.target.checked } });
                        }}
                      />
                      允许读取文件 / 列目录
                    </label>
                    <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.375rem' }}>
                      <input
                        type="checkbox"
                        checked={selectedMcpConfig.allowWrite}
                        onChange={(e) => {
                          if (!mcpSelectedRoleId) return;
                          updateRole(mcpSelectedRoleId, { mcpConfig: { ...selectedMcpConfig, allowWrite: e.target.checked } });
                        }}
                      />
                      允许写入文件
                    </label>
                  </div>

                  <div className={styles.divider} />
                  <div className={styles.sectionTitle}>允许访问的目录</div>
                  <div className={styles.hint} style={{ marginBottom: '0.5rem' }}>
                    留空表示拒绝所有路径访问。请添加允许访问的目录以启用文件功能。
                  </div>
                  {selectedMcpConfig.allowedDirs.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '0.5rem' }}>
                      {selectedMcpConfig.allowedDirs.map((dir, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <code style={{ flex: 1, fontSize: '0.8125rem', background: '#f3f4f6', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {dir}
                          </code>
                          <button
                            className={styles.cancelButton}
                            onClick={() => {
                              if (!mcpSelectedRoleId) return;
                              updateRole(mcpSelectedRoleId, { mcpConfig: { ...selectedMcpConfig, allowedDirs: selectedMcpConfig.allowedDirs.filter((_, idx) => idx !== i) } });
                            }}
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {window.electronAPI ? (
                    <button
                      className={styles.newRoleButton}
                      onClick={async () => {
                        if (!mcpSelectedRoleId) return;
                        const folder = await window.electronAPI!.selectFolder();
                        if (folder) updateRole(mcpSelectedRoleId, { mcpConfig: { ...selectedMcpConfig, allowedDirs: [...selectedMcpConfig.allowedDirs, folder] } });
                      }}
                    >
                      + 添加目录
                    </button>
                  ) : (
                    <div className={styles.hint}>文件工具仅在桌面端（Electron）可用</div>
                  )}

                  <div className={styles.divider} />
                  <div className={styles.sectionTitle}>已注册工具</div>
                  {mcpRegistry.getDefinitions().length === 0 ? (
                    <div className={styles.hint}>暂无已注册工具</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      {mcpRegistry.getDefinitions().map((tool) => (
                        <div key={tool.function.name} style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                          <code style={{ fontSize: '0.8125rem', color: '#065f46', background: '#f0fdf4', padding: '0.125rem 0.375rem', borderRadius: '0.25rem' }}>
                            {tool.function.name}
                          </code>
                          <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{tool.function.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>


      </div>
    </div>
  );
}
