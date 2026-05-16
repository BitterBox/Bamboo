// ============================================================
// ModelConfigModal — 模型参数配置弹窗
// 从 ModelSwitcher 右侧齿轮按钮唤出，用于配置当前会话的
// 服务商、模型及参数（temperature / maxTokens / topK）
// ============================================================

import { useState, useMemo, useEffect } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import { getAllModels } from '../services/llmUtils';
import type { LLMConfig } from '../types';
import Modal from './Modal';
import styles from './ModelConfigModal.module.css';

interface ModelConfigModalProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}

export default function ModelConfigModal({ open, onClose, sessionId }: ModelConfigModalProps) {
  const { apiProviders } = useSettingsStore();
  const session = useChatStore((s) => s.sessions[sessionId]);
  const updateSessionLLMConfig = useChatStore((s) => s.updateSessionLLMConfig);

  const effectiveConfig: LLMConfig = session?.llmConfig ?? { model: '' };

  // 本地编辑状态
  const [providerId, setProviderId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [topK, setTopK] = useState<string>('');

  // 每次弹窗打开时从 session 同步到本地状态
  useEffect(() => {
    if (!open) return;
    const s = useChatStore.getState().sessions[sessionId];
    const cfg: LLMConfig = s?.llmConfig ?? { model: '' };
    setProviderId(cfg.providerId ?? '');
    setModel(cfg.model ?? '');
    setTemperature(cfg.temperature ?? 0.7);
    setMaxTokens(cfg.maxTokens?.toString() ?? '');
    setTopK(cfg.topK?.toString() ?? '');
  }, [open, sessionId]);

  // 已启用且有聊天模型的服务商
  const enabledProviders = useMemo(() => {
    return apiProviders.filter((p) => {
      if (!p.enabled) return false;
      const allModels = getAllModels(p);
      return allModels.some((m) => m.capabilities.includes('chat')) ||
        (p.activeModels ?? []).length > 0 ||
        (p.customModels ?? []).length > 0;
    });
  }, [apiProviders]);

  // 当前选中服务商的模型列表
  const modelOptions = useMemo(() => {
    const provider = apiProviders.find((p) => p.id === providerId);
    if (!provider) return [];
    const allModels = getAllModels(provider);
    const chatModels = allModels.filter((m) => m.capabilities.includes('chat'));
    const activeChatModels = (provider.activeModels ?? []).filter((id) => {
      const info = allModels.find((m) => m.id === id);
      return !info || info.capabilities.includes('chat');
    });
    return activeChatModels.length > 0 ? activeChatModels : chatModels.map((m) => m.id);
  }, [apiProviders, providerId]);

  // 当切换服务商时自动选择第一个模型
  const handleProviderChange = (newProviderId: string) => {
    setProviderId(newProviderId);
    const provider = apiProviders.find((p) => p.id === newProviderId);
    if (!provider) { setModel(''); return; }
    const allModels = getAllModels(provider);
    const chatModels = allModels.filter((m) => m.capabilities.includes('chat'));
    const firstModel = chatModels[0]?.id ?? '';
    setModel(firstModel);
  };

  const handleApply = () => {
    updateSessionLLMConfig(sessionId, {
      ...effectiveConfig,
      providerId: providerId || undefined,
      model,
      temperature,
      maxTokens: maxTokens === '' ? undefined : parseInt(maxTokens) || undefined,
      topK: topK === '' ? undefined : parseInt(topK) || undefined,
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="模型配置"
      maxWidth="480px"
      footer={
        <>
          <button className={styles.cancelBtn} onClick={onClose}>取消</button>
          <button className={styles.applyBtn} onClick={handleApply}>应用</button>
        </>
      }
    >
      {/* 服务商选择 */}
      <div className={styles.field}>
        <label className={styles.label}>服务商</label>
        <select
          className={styles.select}
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          {enabledProviders.length === 0 && (
            <option value="">暂无可用服务商</option>
          )}
          {enabledProviders.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* 模型选择 */}
      <div className={styles.field}>
        <label className={styles.label}>模型</label>
        <select
          className={styles.select}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {modelOptions.length === 0 && (
            <option value="">暂无可用模型</option>
          )}
          {modelOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className={styles.divider} />

      {/* Temperature */}
      <div className={styles.field}>
        <label className={styles.label}>Temperature</label>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className={styles.slider}
          />
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={temperature.toFixed(1)}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) setTemperature(Math.min(2, Math.max(0, v)));
            }}
            className={styles.sliderInput}
          />
        </div>
        <p className={styles.hint}>随机性控制：0 = 确定性输出，2 = 最大创意</p>
      </div>

      {/* Max Tokens */}
      <div className={styles.field}>
        <label className={styles.label}>最大 Tokens</label>
        <input
          type="number"
          className={styles.input}
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
          placeholder="不设置（使用模型默认值）"
          min="1"
        />
      </div>

      {/* Top K */}
      <div className={styles.field}>
        <label className={styles.label}>Top K</label>
        <input
          type="number"
          className={styles.input}
          value={topK}
          onChange={(e) => setTopK(e.target.value)}
          placeholder="不设置（使用模型默认值）"
          min="1"
        />
      </div>
    </Modal>
  );
}