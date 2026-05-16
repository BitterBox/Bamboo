import { ACCEPT_TYPES } from '../../utils/fileImport';
import { AttachIcon } from '../icons';
import { useChatStore } from '../../store/chatStore';
import styles from '../../pages/Chat.module.css';

interface ChatInputProps {
  inputContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesCount: number;
  sessionStats: { words: number; tokens: number; isExact: boolean };
  input: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isProcessing: boolean;
  isQueued: boolean;
  isRateLimited: boolean;
  isAgentRunning: boolean;
  isStreaming: boolean;
  currentToolName?: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStop: () => void;
}

function getPlaceholder(
  isQueued: boolean,
  isRateLimited: boolean,
  isAgentRunning: boolean,
  isStreaming: boolean,
  currentToolName?: string,
  queuedHolderNames?: string,
): string {
  if (isQueued) {
    return queuedHolderNames
      ? `排队中（等待"${queuedHolderNames}"释放文件锁...）`
      : '排队中（等待其他会话释放文件锁...）';
  }
  if (isAgentRunning) {
    if (currentToolName) return `正在执行 ${currentToolName}...`;
    if (!isStreaming) return '正在使用工具...';
  }
  if (isRateLimited) return '限流窗口排队中...';
  if (isStreaming) return '正在生成回复...';
  return '输入消息 (Shift+Enter 换行)';
}

export default function ChatInput({
  inputContainerRef,
  messagesCount,
  sessionStats,
  input,
  inputRef,
  fileInputRef,
  isProcessing,
  isQueued,
  isRateLimited,
  isAgentRunning,
  isStreaming,
  currentToolName,
  onInputChange,
  onSubmit,
  onKeyDown,
  onFileImport,
  onStop,
}: ChatInputProps) {
  // 从 store 查找持有锁的会话名称
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const updateSessionThinkingMode = useChatStore((s) => s.updateSessionThinkingMode);
  const currentSession = currentSessionId ? sessions[currentSessionId] : null;
  const queuedHolderNames = currentSession?.queuedHolderIds?.length
    ? currentSession.queuedHolderIds
        .map((id) => sessions[id]?.title || id)
        .join('、')
    : undefined;

  const thinkingMode = currentSession?.thinkingMode ?? 'auto';

  /** 循环切换思考模式：auto → enabled → disabled → auto */
  const cycleThinkingMode = () => {
    if (!currentSessionId) return;
    const next: Record<string, 'auto' | 'enabled' | 'disabled'> = {
      auto: 'enabled',
      enabled: 'disabled',
      disabled: 'auto',
    };
    updateSessionThinkingMode(currentSessionId, next[thinkingMode]);
  };

  const thinkingLabel = thinkingMode === 'auto' ? '思考' : thinkingMode === 'enabled' ? '思考:开' : '思考:关';

  return (
    <div ref={inputContainerRef} className={styles.inputContainer}>
      {messagesCount > 0 && (
        <div className={styles.sessionStats}>
          本次对话：{sessionStats.words} 词 | {sessionStats.isExact ? '' : '约'}{sessionStats.tokens} token
        </div>
      )}
      <div className={styles.inputToolbar}>
        <button
          type="button"
          className={`${styles.thinkingToggle} ${thinkingMode === 'enabled' ? styles.thinkingToggleOn : ''} ${thinkingMode === 'disabled' ? styles.thinkingToggleOff : ''}`}
          onClick={cycleThinkingMode}
          title={`思考模式：${thinkingMode === 'auto' ? '自动（根据模型能力）' : thinkingMode === 'enabled' ? '强制开启' : '强制关闭'}（点击切换）`}
        >
          {thinkingLabel}
        </button>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
        className={styles.inputForm}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_TYPES}
          multiple
          onChange={onFileImport}
          style={{ display: 'none' }}
        />
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            const value = e.target.value;
            onInputChange(value);
            // 自动扩展高度，最大 160px（防止输入框过高遮挡消息列表）
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            // Enter 发送，Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
            onKeyDown(e);
          }}
          placeholder={getPlaceholder(isQueued, isRateLimited, isAgentRunning, isStreaming, currentToolName, queuedHolderNames)}
          className={styles.input}
          rows={1}
        />
        {/* 导入文件按钮（处理中禁用） */}
        <button
          type="button"
          className={styles.importButton}
          disabled={isProcessing}
          onClick={() => fileInputRef.current?.click()}
          title="导入文件（PDF / 文本）"
        >
          <AttachIcon size={16} />
        </button>
        {/* 正在处理中（流式输出 / 工具执行 / 排队中）显示"停止"按钮，否则显示"发送"按钮 */}
        {isProcessing ? (
          <button
            type="button"
            onClick={onStop}
            className={styles.stopButton}
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className={styles.submitButton}
          >
            发送
          </button>
        )}
      </form>
    </div>
  );
}
