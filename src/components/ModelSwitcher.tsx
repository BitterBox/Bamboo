import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import { getAllModels } from '../services/llmUtils';
import type { LLMConfig } from '../types';
import ModelConfigModal from './ModelConfigModal';
import styles from './ModelSwitcher.module.css';

/**
 * 聊天界面快捷模型/服务商切换器
 * 直接修改当前会话的 LLM 配置（创建时已从智能体快照，不再回退）
 * 右侧齿轮按钮唤出模型参数配置弹窗
 */
export function ModelSwitcher({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const { apiProviders } = useSettingsStore();
  const updateSessionLLMConfig = useChatStore((s) => s.updateSessionLLMConfig);
  const [isOpen, setIsOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 直接从当前会话读取配置
  const session = useChatStore((s) => s.sessions[sessionId]);
  const effectiveConfig: LLMConfig = session?.llmConfig ?? { model: '' };
  const currentProvider = apiProviders.find((p) => p.id === effectiveConfig.providerId);
  const displayProvider = currentProvider?.name ?? '—';
  const displayModel = effectiveConfig.model || '—';

  // 只显示已启用且有可用聊天模型的服务商（包括 activeModels 中的聊天模型和 customModels 中的聊天模型）
  const visibleProviders = apiProviders.filter((p) => {
    if (!p.enabled) return false;
    const allModels = getAllModels(p);
    const chatModels = allModels.filter((m) => m.capabilities.includes('chat'));
    if (chatModels.length > 0) return true;
    // 即使没有聊天模型，有 activeModels（可能未设置能力）也应该显示
    return (p.activeModels ?? []).length > 0 || (p.customModels ?? []).length > 0;
  });

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const handleSelectModel = (providerId: string, model: string) => {
    const provider = apiProviders.find((p) => p.id === providerId);
    if (!provider) return;
    const session = useChatStore.getState().sessions[sessionId];
    if (!session) return;
    updateSessionLLMConfig(sessionId, {
      ...session.llmConfig,
      providerId,
      model,
    });
    setIsOpen(false);
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        className={styles.trigger}
        onClick={() => setIsOpen((v) => !v)}
        aria-label="切换模型"
      >
        <span className={styles.label}>对话模型:</span>
        <span className={styles.name}>{displayProvider} · {displayModel}</span>
        <span className={styles.arrow}>{isOpen ? '▲' : '▼'}</span>
      </button>

      <button
        className={styles.settingsBtn}
        onClick={() => setIsConfigOpen(true)}
        aria-label="模型参数配置"
        title="模型参数配置"
      >
        ⚙
      </button>

      <ModelConfigModal
        open={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        sessionId={sessionId}
      />

      {isOpen && (
        <div className={styles.dropdown}>
          {visibleProviders.length === 0 ? (
            <div className={styles.empty}>暂无激活模型</div>
          ) : (
            visibleProviders.map((provider, idx) => {
              const allModels = getAllModels(provider);
              const chatModels = allModels.filter((m) => m.capabilities.includes('chat'));
              // 优先显示 activeModels 中的聊天模型，否则显示全量聊天模型
              const activeChatModels = (provider.activeModels ?? []).filter((id) => {
                const info = allModels.find((m) => m.id === id);
                return !info || info.capabilities.includes('chat');
              });
              const displayModels = activeChatModels.length > 0 ? activeChatModels : chatModels.map((m) => m.id);

              return (
                <div key={provider.id}>
                  {idx > 0 && <div className={styles.divider} />}
                  <div className={styles.providerHeader}>{provider.name}</div>
                  {displayModels.map((model) => {
                    const isCurrent = provider.id === effectiveConfig.providerId && model === effectiveConfig.model;
                    return (
                      <button
                        key={model}
                        className={`${styles.option} ${isCurrent ? styles.active : ''}`}
                        onClick={() => handleSelectModel(provider.id, model)}
                      >
                        <span>{model}</span>
                        {isCurrent && <span className={styles.check}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
          <div className={styles.divider} />
          <button
            className={styles.manageButton}
            onClick={() => { navigate('/settings'); setIsOpen(false); }}
          >
            ⚙ 管理服务商...
          </button>
        </div>
      )}
    </div>
  );
}
