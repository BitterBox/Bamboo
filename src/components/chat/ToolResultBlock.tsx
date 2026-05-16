import { useState, memo } from 'react';
import { TOOL_RESULT_COLLAPSE_LIMIT } from '../../utils/chatConstants';
import { CopyIcon } from '../icons';
import styles from '../../pages/Chat.module.css';

/**
 * 工具执行结果展示组件
 *
 * 大尺寸结果（>800 字符）默认折叠为摘要，点击展开查看完整内容，
 * 避免 read_file 2000 行 / modify_code 大段 diff 一次性插入大量 DOM 导致卡顿。
 *
 * 特殊处理 _reconcile_tool_call_id：用醒目的黄色提示条展示修复内容。
 *
 * 内联操作按钮：当作为 assistant 气泡内嵌内容渲染时，可提供 onDelete / onRerun
 * 回调，在结果头部右侧显示小按钮。
 */
function ToolResultBlock({
  content,
  name,
  isError,
  onDelete,
  onRerun,
}: {
  content: string;
  name?: string;
  isError?: boolean;
  /** 删除此工具结果（内联模式专用） */
  onDelete?: () => void;
  /** 重新执行此工具调用（内联模式专用） */
  onRerun?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);

  const handleCopyContent = () => {
    navigator.clipboard.writeText(content).then(() => {
      setContentCopied(true);
      setTimeout(() => setContentCopied(false), 2000);
    }).catch((err) => {
      console.error('[Copy] 复制工具结果失败:', err);
    });
  };
  // 🔧 仅通过 name 判断是否为一致性修复结果（reconcile 模块已统一设置 name 为 _reconcile_tool_call_id）
  const isReconcileResult = name === '_reconcile_tool_call_id';

  // 🔧 对一致性修复结果特殊渲染：直接展示修复消息，不需要展开/折叠
  if (isReconcileResult) {
    let displayMsg = content;
    try {
      const parsed = JSON.parse(content);
      if (parsed.message) displayMsg = parsed.message;
      if (parsed.status === 'reconciled') {
        displayMsg = `⚠️ ${parsed.message || '系统已自动修复工具调用一致性'}`;
      }
    } catch { /* content 不是 JSON，直接展示 */ }
    return (
      <div style={{
        padding: '8px 12px',
        margin: '4px 0',
        fontSize: '13px',
        color: '#856404',
        background: '#fff3cd',
        border: '1px solid #ffeeba',
        borderRadius: '6px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      }}>
        {displayMsg}
      </div>
    );
  }
  const shouldCollapse = content.length > TOOL_RESULT_COLLAPSE_LIMIT;

  return (
    <div className={styles.toolResultBlock}>
      <div className={styles.toolResultHeader}>
        <span className={isError ? styles.toolResultIconError : styles.toolResultIconOk}>
          {isError ? '✕' : '✓'}
        </span>
        <code className={styles.toolResultName}>{name ?? '工具'}</code>
        {/* 内联操作按钮：仅在作为 assistant 内嵌内容时显示 */}
        {(onRerun || onDelete) && (
          <span className={styles.toolResultActions}>
            <button
              className={styles.toolResultActionBtn}
              onClick={(e) => { e.stopPropagation(); handleCopyContent(); }}
              title="复制工具结果"
            >
              {contentCopied ? '✓' : <CopyIcon size={11} strokeWidth={2.5} />}
            </button>
            {onRerun && (
              <button
                className={styles.toolResultActionBtn}
                onClick={(e) => { e.stopPropagation(); onRerun(); }}
                title="重新执行此工具"
              >
                ↻
              </button>
            )}
            {onDelete && (
              <button
                className={styles.toolResultActionBtn}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="删除此工具结果"
              >
                ✕
              </button>
            )}
          </span>
        )}
      </div>
      {shouldCollapse && !expanded ? (
        <div className={styles.toolResultCollapsed}>
          <pre className={styles.toolResultContent}>
            {content.slice(0, TOOL_RESULT_COLLAPSE_LIMIT)}
          </pre>
          <button
            className={styles.toolResultExpandBtn}
            onClick={() => setExpanded(true)}
          >
            展开完整结果（共 {content.length.toLocaleString()} 字符）
          </button>
        </div>
      ) : (
        <pre className={styles.toolResultContent}>{content}</pre>
      )}
    </div>
  );
};

export default memo(ToolResultBlock, (prev, next) =>
  prev.content === next.content &&
  prev.name === next.name &&
  prev.isError === next.isError
);
