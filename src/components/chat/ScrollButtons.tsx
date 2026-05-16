import { ChevronDoubleUpIcon, AutoScrollIcon, ChevronDoubleDownIcon, SkipPrevIcon, SkipNextIcon } from '../icons';
import styles from '../../pages/Chat.module.css';

interface ScrollButtonsProps {
  hasMessages: boolean;
  scrollToTop: () => void;
  scrollToPrevUser: () => void;
  scrollToNextUser: () => void;
  isStreaming: boolean;
  isAgentRunning: boolean;
  autoScroll: boolean;
  toggleAutoScroll: () => void;
  scrollToBottom: () => void;
}

export default function ScrollButtons({
  hasMessages,
  scrollToTop,
  scrollToPrevUser,
  scrollToNextUser,
  isStreaming,
  isAgentRunning,
  autoScroll,
  toggleAutoScroll,
  scrollToBottom,
}: ScrollButtonsProps) {
  return (
    <>
      {hasMessages && (
        <>
          {/* 置顶按钮 - 如有隐藏消息先全部加载再滚动到顶部 */}
          <button
            className={styles.scrollToTopBtn}
            onClick={scrollToTop}
            title="回到顶部"
          >
            <ChevronDoubleUpIcon size={14} />
          </button>

          {/* 到上一条 user 信息 */}
          <button
            className={styles.scrollToPrevUserBtn}
            onClick={scrollToPrevUser}
            title="到上一条 user 信息"
          >
            <SkipPrevIcon size={14} />
          </button>

          {/* 到下一条 user 信息 */}
          <button
            className={styles.scrollToNextUserBtn}
            onClick={scrollToNextUser}
            title="到下一条 user 信息"
          >
            <SkipNextIcon size={14} />
          </button>
        </>
      )}

      {/* 跟随滚动按钮 - 在流式生成或 Agent 运行时显示（与 autoScroll 生效条件一致） */}
      {(isStreaming || isAgentRunning) ? (
        <button
          className={`${styles.autoScrollBtn} ${autoScroll ? styles.autoScrollOn : ''}`}
          onClick={toggleAutoScroll}
          title={autoScroll ? '已开启跟随滚动，点击关闭' : '已关闭跟随滚动，点击开启'}
        >
          <AutoScrollIcon size={14} />
        </button>
      ) : (
        <button
          className={styles.scrollToBottomBtn}
          onClick={scrollToBottom}
          title="滚动到底部"
        >
          <ChevronDoubleDownIcon size={14} />
        </button>
      )}
    </>
  );
}
