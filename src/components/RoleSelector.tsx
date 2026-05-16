import { useState, useRef, useEffect } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import styles from './RoleSelector.module.css';

/**
 * 智能体选择器组件
 * 显示当前会话绑定的智能体，支持快速切换
 * 每个会话独立维护自己的智能体绑定
 */
export function RoleSelector() {
  const roles = useSettingsStore((s) => s.roles);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessionAgentId = useChatStore((s) =>
    s.currentSessionId ? (s.sessions[s.currentSessionId]?.agentId ?? null) : null
  );
  const setSessionRole = useChatStore((s) => s.setSessionRole);

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeRole = roles.find((r) => r.id === sessionAgentId);
  const displayName = activeRole?.name || '默认';

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleSelectAgent = (agentId: string | null) => {
    if (currentSessionId) {
      setSessionRole(currentSessionId, agentId);
    }
    setIsOpen(false);
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="选择智能体"
      >
        <span className={styles.label}>智能体:</span>
        <span className={styles.name}>{displayName}</span>
        <span className={styles.arrow}>{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <button
            className={`${styles.option} ${!sessionAgentId ? styles.active : ''}`}
            onClick={() => handleSelectAgent(null)}
          >
            <span>默认</span>
            {!sessionAgentId && <span className={styles.check}>✓</span>}
          </button>

          {roles.map((role) => (
            <button
              key={role.id}
              className={`${styles.option} ${sessionAgentId === role.id ? styles.active : ''}`}
              onClick={() => handleSelectAgent(role.id)}
            >
              <span>{role.name}</span>
              {sessionRoleId === role.id && <span className={styles.check}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
