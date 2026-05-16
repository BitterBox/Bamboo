import { ModelSwitcher } from '../ModelSwitcher';
import { ChevronIcon, FlowChartIcon } from '../icons';
import styles from '../../pages/Chat.module.css';

interface ChatHeaderProps {
  title: string;
  showTree: boolean;
  sessionId: string;
  onToggleTree: () => void;
  onClearConversation: () => void;
}

export default function ChatHeader({
  title,
  showTree,
  sessionId,
  onToggleTree,
  onClearConversation,
}: ChatHeaderProps) {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>
        {title || 'LLM Chat Demo'}
      </h1>
      <ModelSwitcher sessionId={sessionId} />
      <div className={styles.headerActions}>
        <button
          onClick={onToggleTree}
          className={`${styles.treeButton} ${showTree ? styles.treeButtonActive : ''}`}
          title={showTree ? '返回对话' : '对话总览（树形图）'}
        >
          {showTree ? <ChevronIcon direction="left" size={18} /> : <FlowChartIcon size={18} />}
        </button>
        {!showTree && (
          <button
            onClick={onClearConversation}
            className={styles.clearButton}
          >
            清空对话
          </button>
        )}
      </div>
    </div>
  );
}
