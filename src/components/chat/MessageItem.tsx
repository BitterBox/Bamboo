import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { ROLE_LABELS } from '../../utils/chatConstants';
import { countStats } from '../../utils/countStats';
import { detectFileMessage } from '../../utils/fileImport';
import { getDirectBranchLeaves } from '../../utils/treeUtils';
import { useChatStore } from '../../store/chatStore';
import MarkdownContent from '../MarkdownContent';
import ToolResultBlock from './ToolResultBlock';
import { EditIcon, CopyIcon, RetryIcon, ContinueIcon, DeleteIcon } from '../icons';
import type { Message, TokenUsage } from '../../types';
import styles from '../../pages/Chat.module.css';

interface MessageItemProps {
  message: Message;
  isLastMessage: boolean;
  isEditing: boolean;
  editContent: string;
  editMinHeight: number | undefined;
  editTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  isAgentRunning: boolean;
  isQueued: boolean;
  lastToolCallMsgId: string | undefined;
  expandedReasoning: Set<string>;
  onToggleReasoning: (id: string) => void;
  expandedToolCalls: Set<string>;
  onToggleToolCall: (id: string) => void;
  appConfig: { fontSize: number; lineHeight: number };
  shortcutConfig: {
    editMessage: string[];
    retryMessage: string[];
    continueFrom: string[];
    copyMessage: string[];
    deleteMessage: string[];
  };
  currentSessionId: string | null;
  systemRoleName?: string;
  onEditStart: (id: string) => void;
  onEditContentChange: (content: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  onEditSubmit: (id: string, resend?: boolean) => void;
  onCancelEdit: () => void;
  onRoleChange: (sessionId: string, messageId: string, role: Message['role']) => void;
  onRetry: (id: string) => void;
  onCopy: (id: string) => void;
  onContinueFrom: (id: string) => void;
  onDelete: (id: string) => void;
  onBranchSwitch: (sessionId: string, leafId: string) => void;
  viewLeafId?: string | null;
  autoResizeEditTextarea: (el: HTMLTextAreaElement) => void;
  /** 所有 tool 结果消息，按 toolCallId 索引（用于内联渲染） */
  toolResultByCallId?: Map<string, Message>;
  /** 所有已匹配的 toolCallId（对应结果应内联，不独立渲染） */
  inlinedToolCallIds?: Set<string>;
  /** 重新执行单个工具调用（toolCallId → 删除旧结果 → 重新执行 → addMessage） */
  onRerunTool?: (toolCallId: string, toolName: string, toolArgs: string) => void;
}

function MessageItem({
  message,
  isLastMessage,
  isEditing,
  editContent,
  editMinHeight,
  editTextareaRef,
  isStreaming,
  isAgentRunning,
  isQueued,
  lastToolCallMsgId,
  expandedReasoning,
  onToggleReasoning,
  expandedToolCalls,
  onToggleToolCall,
  appConfig,
  shortcutConfig,
  currentSessionId,
  systemRoleName,
  onEditStart,
  onEditContentChange,
  onEditKeyDown,
  onEditSubmit,
  onCancelEdit,
  onRoleChange,
  onRetry,
  onCopy,
  onContinueFrom,
  onDelete,
  onBranchSwitch,
  viewLeafId,
  autoResizeEditTextarea,
  childToolMessages: toolResultByCallId,
  inlinedToolCallIds,
  onRerunTool,
}: MessageItemProps) {
  // ── 复制按钮反馈状态 ──────────────────────────────────
  const [copied, setCopied] = useState(false);

  // ── 右键菜单状态 ──────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  /** 关闭右键菜单 */
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  /** 消息右键事件 → 弹出上下文菜单 */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 如果选中了文本，让 Electron 原生菜单处理（复制/剪切/格物）
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        return; // 不拦截，冒泡给 Electron 原生 context-menu 事件
      }
      e.preventDefault();
      e.stopPropagation();
      // 编辑模式下不弹出右键菜单（编辑框有自己的原生菜单）
      if (isEditing) return;
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [isEditing],
  );

  // 点击/右键菜单外任意位置关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };
    // 用 capture 阶段尽早拦截
    window.addEventListener('mousedown', handler, true);
    window.addEventListener('contextmenu', handler, true);
    return () => {
      window.removeEventListener('mousedown', handler, true);
      window.removeEventListener('contextmenu', handler, true);
    };
  }, [contextMenu, closeContextMenu]);

  // ── 内联渲染：非孤儿 tool 消息不渲染独立气泡 ──────────
  // 如果此 tool 消息的 toolCallId 存在于某个 assistant 的 toolCalls 中，
  // 则该 tool 结果由父 assistant 气泡内联渲染，此处返回 null。
  const isInlined =
    message.role === 'tool' &&
    message.toolResult?.toolCallId != null &&
    inlinedToolCallIds?.has(message.toolResult.toolCallId);

  if (isInlined) {
    return null;
  }

  return (
    <div
      className={`${styles.messageWrapper} ${styles[message.role]}`}
      onContextMenu={handleContextMenu}
    >
      <div className={styles.messageGroup}>
        {/* 消息气泡：编辑模式时切换为 textarea */}
        <div
          id={`msg-${message.id}`}
          className={`${styles.message} ${message.role === 'system' ? styles.systemPromptMessage : styles[message.role]}${isEditing ? ` ${styles.editing}` : ''}`}
          style={isEditing && editMinHeight ? { minHeight: editMinHeight } : undefined}
        >
          {isEditing ? (
            <>
              {/* 角色选项卡：三个角色并排，点击即切换 */}
              {message.role !== 'tool' && (
                <div className={styles.editTabs}>
                  {(['user', 'assistant'] as const).map((role) => (
                    <button
                      key={role}
                      className={`${styles.editTab} ${message.role === role ? styles.editTabActive : ''}`}
                      onClick={() => {
                        if (currentSessionId && message.role !== role) {
                          onRoleChange(currentSessionId, message.id, role);
                        }
                      }}
                    >
                      {role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '⚙️'}
                      {' '}
                      {ROLE_LABELS[role]}
                    </button>
                  ))}
                </div>
              )}
              {/* 编辑内容 */}
              <textarea
                ref={editTextareaRef}
                className={styles.editTextarea}
                value={editContent}
                onChange={(e) => {
                  onEditContentChange(e.target.value);
                  autoResizeEditTextarea(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onEditSubmit(message.id);
                  }
                  if (e.key === 'Escape') onCancelEdit();
                  onEditKeyDown(e);
                }}
                autoFocus
              />
            </>
          ) : message.role === 'system' ? (
            <div className={styles.systemPromptBubble}>
              <div className={styles.systemPromptBubbleHeader}>
                <span className={styles.systemPromptBubbleIcon}>💡</span>
                <span className={styles.systemPromptBubbleTitle}>{systemRoleName || '系统'}</span>
              </div>
              <div className={styles.systemPromptBubbleContent} style={{ fontSize: appConfig.fontSize, lineHeight: appConfig.lineHeight }}>
                <UserOrSystemContent content={message.content} />
              </div>
            </div>
          ) : (
            <div className={styles.messageContent} style={{ fontSize: appConfig.fontSize, lineHeight: appConfig.lineHeight }}>
              {message.role === 'tool' ? (
                <ToolResultBlock
                  content={message.content}
                  name={message.toolResult?.name}
                  isError={message.toolResult?.isError}
                />
              ) : message.role === 'assistant' ? (
                <>
                  {/* 思考链区块 */}
                  {message.reasoning && (
                    <ReasoningBlock
                      reasoning={message.reasoning}
                      isStreaming={isLastMessage}
                      isExpanded={isLastMessage || expandedReasoning.has(message.id)}
                      onToggle={() => onToggleReasoning(message.id)}
                    />
                  )}
                  {/* 🟢 工具调用生成中但尚无内容时，显示加载占位，避免气泡空白 */}
                  {isLastMessage && isStreaming && isAgentRunning && !message.content && !message.toolCalls?.length && (
                    <div className={styles.agentLoading}>正在分析…</div>
                  )}
                  <MarkdownContent
                    content={message.content}
                    isStreaming={isLastMessage}
                  />
                  {/* 工具调用区块 */}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className={styles.toolCallsBlock}>
                      {message.toolCalls.map((tc) => {
                        const isThisProcessing = isStreaming
                          ? isLastMessage
                          : (isAgentRunning || isQueued) && message.id === lastToolCallMsgId;
                        const isExpanded = isThisProcessing || expandedToolCalls.has(tc.id);
                        // 查找此 toolCall 对应的 tool 结果消息
                        const resultMsg = toolResultByCallId?.get(tc.id);
                        return (
                          <div key={tc.id} className={styles.toolCallWithResult}>
                            <ToolCallItem
                              tc={tc}
                              isThisProcessing={isThisProcessing}
                              isQueued={isQueued}
                              isExpanded={isExpanded}
                              onToggle={() => onToggleToolCall(tc.id)}
                            />
                            {/* 工具执行结果内联在 toolCall 下方 */}
                            {resultMsg && (
                              <div className={styles.toolResultInline}>
                                <ToolResultBlock
                                  content={resultMsg.content}
                                  name={resultMsg.toolResult?.name}
                                  isError={resultMsg.toolResult?.isError}
                                  onDelete={
                                    onDelete
                                      ? () => onDelete(resultMsg.id)
                                      : undefined
                                  }
                                  onRerun={
                                    onRerunTool
                                      ? () => onRerunTool(tc.id, tc.name, tc.arguments)
                                      : undefined
                                  }
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <UserOrSystemContent content={message.content} />
              )}
            </div>
          )}

          {/* 消息底部：角色标签 + 时间戳 + 模型名 + 词数/token — 始终可见 */}
          <div className={styles.messageFooter}>
            <span className={styles.roleTag}>{ROLE_LABELS[message.role]}</span>
            <span className={styles.messageTime}>
              {new Date(message.timestamp).toLocaleString()}
            </span>
            {message.role === 'assistant' && message.model && (
              <span className={styles.messageModel}>
                {message.providerName ? `${message.providerName}|` : ''}{message.model}
              </span>
            )}
            <MessageStats message={message} isEditing={isEditing} toolResultByCallId={toolResultByCallId} />
          </div>

          {/* 编辑模式操作按钮 */}
          {isEditing && (
            <div className={styles.editActions}>
              {message.role === 'user' && (
                <button
                  className={styles.editSaveOnlyBtn}
                  onClick={() => onEditSubmit(message.id, false)}
                >
                  保存
                </button>
              )}
              <button
                className={styles.editSaveBtn}
                onClick={() => onEditSubmit(message.id)}
              >
                {message.role === 'user' ? '保存并重发' : '保存'}
              </button>
              <button
                className={styles.editCancelBtn}
                onClick={onCancelEdit}
              >
                取消
              </button>
            </div>
          )}
        </div>

        {/* 消息操作工具栏（非编辑模式时显示） */}
        {!isEditing && (
          <div className={styles.messageActions}>
            {/* 分支切换指示器 */}
            {(() => {
              const state = useChatStore.getState();
              const session = currentSessionId ? state.sessions[currentSessionId] : null;
              const leafId = viewLeafId ?? session?.viewLeafId;
              const branchLeaves = session
                ? getDirectBranchLeaves(session.messageTree, message.id, leafId)
                : [];
              if (branchLeaves.length > 1) {
                const currentIdx = leafId
                  ? branchLeaves.indexOf(leafId)
                  : -1;
                if (currentIdx === -1) return null;
                const isViewOnly = isStreaming || isAgentRunning;
                return (
                  <button
                    className={styles.branchIndicator}
                    onClick={(e) => {
                      e.stopPropagation();
                      const delta = e.shiftKey ? branchLeaves.length - 1 : 1;
                      const nextIdx = (currentIdx + delta) % branchLeaves.length;
                      onBranchSwitch(session!.id, branchLeaves[nextIdx]);
                    }}
                    title={
                      isViewOnly
                        ? `${branchLeaves.length} 个分支 (点击切换查看，流式继续写入原分支)`
                        : `${branchLeaves.length} 个分支 (点击切换下一个 | Shift+点击切换上一个)`
                    }
                  >
                    ● {currentIdx + 1}/{branchLeaves.length}
                  </button>
                );
              }
              return null;
            })()}
            <button
              onClick={() => onEditStart(message.id)}
              title={`编辑 (${shortcutConfig.editMessage.join(' / ')})`}
            >
              <EditIcon />
            </button>
            <button
              onClick={() => onRetry(message.id)}
              title={`重试 (${shortcutConfig.retryMessage.join(' / ')})`}
            >
              <RetryIcon />
            </button>
            <button
              onClick={() => {
                onCopy(message.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              title={copied ? '已复制' : `复制 (${shortcutConfig.copyMessage.join(' / ')})`}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <CopyIcon />
              )}
            </button>
            <button
              onClick={() => onContinueFrom(message.id)}
              title={`继续 (${shortcutConfig.continueFrom.join(' / ')})`}
            >
              <ContinueIcon />
            </button>
            {message.role !== 'system' && (
              <button
                className={styles.deleteBtn}
                onClick={() => onDelete(message.id)}
                title={`删除 (${shortcutConfig.deleteMessage.join(' / ')})`}
              >
                <DeleteIcon />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── 右键上下文菜单 ──────────────────────────────── */}
      {contextMenu && (
        <>
          {/* 全屏透明遮罩：点击或右键任意位置关闭菜单 */}
          <div
            className={styles.contextMenuBackdrop}
            onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }}
          />
          <div
            ref={contextMenuRef}
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div
              className={styles.contextMenuItem}
              onClick={() => { onEditStart(message.id); closeContextMenu(); }}
            >
              <span className={styles.contextMenuIcon}>
                <EditIcon />
              </span>
              编辑
            </div>
            <div
              className={styles.contextMenuItem}
              onClick={() => { onRetry(message.id); closeContextMenu(); }}
            >
              <span className={styles.contextMenuIcon}>
                <RetryIcon />
              </span>
              重试
            </div>
            <div
              className={styles.contextMenuItem}
              onClick={() => {
                onCopy(message.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
                closeContextMenu();
              }}
            >
              <span className={styles.contextMenuIcon}>
                <CopyIcon />
              </span>
              复制
            </div>
            <div
              className={styles.contextMenuItem}
              onClick={() => { onContinueFrom(message.id); closeContextMenu(); }}
            >
              <span className={styles.contextMenuIcon}>
                <ContinueIcon />
              </span>
              从此继续
            </div>
            {message.role !== 'system' && (
              <>
                <div className={styles.contextMenuDivider} />
                <div
                  className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
                  onClick={() => { onDelete(message.id); closeContextMenu(); }}
                >
                  <span className={styles.contextMenuIcon}>
                    <DeleteIcon />
                  </span>
                  删除
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── 内部子组件 ────────────────────────────────────────────────

/** 思考链区块 */
function ReasoningBlock({
  reasoning,
  isStreaming,
  isExpanded,
  onToggle,
}: {
  reasoning: string;
  isStreaming: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [reasoningCopied, setReasoningCopied] = useState(false);

  const handleCopyReasoning = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(reasoning).then(() => {
      setReasoningCopied(true);
      setTimeout(() => setReasoningCopied(false), 2000);
    }).catch((err) => {
      console.error('[Copy] 复制思考链失败:', err);
    });
  };

  return (
    <div className={styles.reasoningBlock}>
      <div className={styles.reasoningHeader}>
        <button className={styles.reasoningToggle} onClick={onToggle}>
          <span className={`${styles.reasoningArrow} ${isExpanded ? styles.reasoningArrowOpen : ''}`}>›</span>
          {isStreaming
            ? '思考中…'
            : `思考过程（${reasoning.length} 字）`}
        </button>
        {!isStreaming && (
          <button
            className={styles.reasoningCopyBtn}
            onClick={handleCopyReasoning}
            title="复制思考链"
          >
            {reasoningCopied ? '✓' : <CopyIcon size={12} strokeWidth={2.5} />}
          </button>
        )}
      </div>
      {isExpanded && (
        <div
          className={styles.reasoningContent}
          data-auto-scroll="reasoning"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

/** 工具调用条目 */
const ToolCallItem = memo(function ToolCallItem({
  tc,
  isThisProcessing,
  isQueued,
  isExpanded,
  onToggle,
}: {
  tc: { id: string; name: string; arguments: string };
  isThisProcessing: boolean;
  isQueued: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  // 🔧 修复：对一致性修复工具（_reconcile_tool_call_id）做特殊渲染，
  // 让用户在对话界面能看到修复说明，而不是一个奇怪的带下划线前缀的工具名。
  const isReconcileTool = tc.name === '_reconcile_tool_call_id';

  let argsPreview: string;
  let reconcileMessage: string | null = null;
  try {
    const parsed = JSON.parse(tc.arguments);
    if (isReconcileTool && parsed.message) {
      reconcileMessage = parsed.message;
      argsPreview = '⚠️ 一致性修复';
    } else {
      argsPreview = Object.values(parsed).map(String).join(', ');
    }
  } catch {
    argsPreview = tc.arguments;
  }

  if (isReconcileTool) {
    return (
      <div className={styles.toolCallItem} style={{ opacity: 0.8 }}>
        <button className={styles.toolCallToggle} onClick={onToggle} title={isExpanded ? '收起详情' : '展开详情'}>
          <span className={`${styles.toolCallArrow} ${isExpanded ? styles.toolCallArrowOpen : ''}`}>›</span>
          <span className={styles.toolCallIcon}>🔧</span>
          <code className={styles.toolCallName} style={{ color: '#b8860b' }}>系统修复</code>
          <span className={styles.toolCallArgsPreview}>{argsPreview}</span>
        </button>
        {isExpanded && reconcileMessage && (
          <div style={{
            padding: '8px 12px',
            margin: '4px 0 0 24px',
            fontSize: '13px',
            color: '#856404',
            background: '#fff3cd',
            border: '1px solid #ffeeba',
            borderRadius: '6px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}>
            {reconcileMessage}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.toolCallItem}>
      <button className={styles.toolCallToggle} onClick={onToggle} title={isExpanded ? '收起参数' : '展开完整参数'}>
        <span className={`${styles.toolCallArrow} ${isExpanded ? styles.toolCallArrowOpen : ''}`}>›</span>
        {isThisProcessing && <span className={styles.toolCallLiveDot} style={isQueued ? { backgroundColor: '#ef4444' } : undefined} />}
        <span className={styles.toolCallIcon}>⚙</span>
        <code className={styles.toolCallName}>{tc.name}</code>
        <span className={styles.toolCallArgsPreview}>{argsPreview}</span>
      </button>
      {isExpanded && <ToolCallArgsFull args={tc.arguments} />}
    </div>
  );
}, (prev, next) =>
  prev.tc === next.tc &&
  prev.isThisProcessing === next.isThisProcessing &&
  prev.isQueued === next.isQueued &&
  prev.isExpanded === next.isExpanded
);

/** 工具调用完整参数 */
function ToolCallArgsFull({ args }: { args: string }) {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return (
        <dl className={styles.argsKeyValueList} data-auto-scroll="tool-args">
          {Object.entries(parsed).map(([key, value]) => (
            <div key={key} className={styles.argsKVRow}>
              <dt className={styles.argsKVKey}>{key}</dt>
              <dd className={styles.argsKVValue}>
                {typeof value === 'string'
                  ? value
                  : JSON.stringify(value, null, 2)}
              </dd>
            </div>
          ))}
        </dl>
      );
    }
    return (
      <pre className={styles.toolCallArgsFull} data-auto-scroll="tool-args">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    return (
      <pre className={styles.toolCallArgsFull} data-auto-scroll="tool-args">{args}</pre>
    );
  }
}

/** 用户/系统消息内容 */
function UserOrSystemContent({ content }: { content: string }) {
  const fileName = detectFileMessage(content);
  if (fileName) {
    return (
      <div className={styles.fileMessageBadge}>
        <span>📄</span>
        <span>{fileName}</span>
      </div>
    );
  }
  return <MarkdownContent content={content} />;
}

/** 消息词数/token 统计 */
function MessageStats({
  message,
  isEditing,
  toolResultByCallId,
}: {
  message: Message;
  isEditing: boolean;
  /** 内联 tool 结果的额外内容统计 */
  toolResultByCallId?: Map<string, Message>;
}) {
  if (isEditing) return null;
  // 基础统计：消息正文
  let totalWords = countStats(message.content).words;
  let totalTokens = countStats(message.content).tokens;
  // 附加统计：内联 tool 结果的内容（已嵌入 assistant 气泡的视觉范围内）
  if (message.role === 'assistant' && toolResultByCallId && message.toolCalls) {
    for (const tc of message.toolCalls) {
      const resultMsg = toolResultByCallId.get(tc.id);
      if (resultMsg) {
        const s = countStats(resultMsg.content);
        totalWords += s.words;
        totalTokens += s.tokens;
      }
    }
  }
  if (totalWords === 0) return null;
  if (message.role === 'assistant' && (message as any).tokenUsage) {
    const usage = (message as any).tokenUsage as TokenUsage;
    return (
      <span className={styles.messageStats}>
        {totalWords}词|{usage.completionTokens}词元
        {usage.ttftMs != null && (
          <>|首词元{usage.ttftMs}ms</>
        )}
        {usage.avgMsPerToken != null && (
          <>|平均{usage.avgMsPerToken}ms/词元</>
        )}
        {usage.totalMs != null && (
          <>|总耗时{(usage.totalMs / 1000).toFixed(1)}s</>
        )}
      </span>
    );
  }
  return (
    <span className={styles.messageStats}>
      {totalWords}词|约{totalTokens}词元
    </span>
  );
}

/**
 * 自定义比较器：仅比较影响视觉输出的 props，跳过函数引用变化，
 * 确保流式过程中只有内容变化的消息才重渲染。
 */
const messageItemComparator = (prev: MessageItemProps, next: MessageItemProps) => {
  if (prev.message !== next.message) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.isEditing && next.isEditing && prev.editContent !== next.editContent) return false;
  if (prev.editMinHeight !== next.editMinHeight) return false;
  if (prev.isLastMessage !== next.isLastMessage) return false;
  // 🔧 修复：比较器缺失 isStreaming / isAgentRunning / lastToolCallMsgId 检查，
  //   导致 Agentic Loop 结束后 isAgentRunning 变为 false 时组件不重渲染，
  //   工具调用指示器常亮且无法收起。
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.isAgentRunning !== next.isAgentRunning) return false;
  if (prev.isQueued !== next.isQueued) return false;
  if (prev.lastToolCallMsgId !== next.lastToolCallMsgId) return false;
  if (prev.viewLeafId !== next.viewLeafId) return false;
  const msgId = prev.message.id;
  if (prev.expandedReasoning.has(msgId) !== next.expandedReasoning.has(msgId)) return false;
  // 检查本条消息中每个工具调用的展开状态是否有变化（expandedToolCalls 存的是 tc.id）
  const toolCallIds = prev.message.toolCalls?.map(tc => tc.id) ?? [];
  for (const tcId of toolCallIds) {
    if (prev.expandedToolCalls.has(tcId) !== next.expandedToolCalls.has(tcId)) return false;
  }
  // 检查此消息的子 tool 结果是否有变化（新增/删除 tool 结果需要重渲染）
  const prevHasResults = prev.message.toolCalls?.some(tc => prev.toolResultByCallId?.has(tc.id)) ?? false;
  const nextHasResults = next.message.toolCalls?.some(tc => next.toolResultByCallId?.has(tc.id)) ?? false;
  if (prevHasResults !== nextHasResults) return false;
  // 检查 tool 结果内容是否变化：重新执行工具后 editMessage 会创建新消息对象，
  // 引用比较 O(1) 即可感知变化，无需扫描字符串内容。
  if (prev.message.toolCalls) {
    for (const tc of prev.message.toolCalls) {
      const prevResult = prev.toolResultByCallId?.get(tc.id);
      const nextResult = next.toolResultByCallId?.get(tc.id);
      if (prevResult !== nextResult) return false;
    }
  }
  // 内联 ID 集合变化（新 assistant 消息携带 toolCalls 时）
  if (prev.inlinedToolCallIds !== next.inlinedToolCallIds) {
    // 仅检查本条消息的 toolCalls 是否被纳入/移出内联集合
    const prevInlined = prev.message.toolCalls?.some(tc => prev.inlinedToolCallIds?.has(tc.id)) ?? false;
    const nextInlined = next.message.toolCalls?.some(tc => next.inlinedToolCallIds?.has(tc.id)) ?? false;
    if (prevInlined !== nextInlined) return false;
  }
  // 外观配置变化（字号/行距）
  if (prev.appConfig.fontSize !== next.appConfig.fontSize) return false;
  if (prev.appConfig.lineHeight !== next.appConfig.lineHeight) return false;
  return true;
};

export default memo(MessageItem, messageItemComparator);
