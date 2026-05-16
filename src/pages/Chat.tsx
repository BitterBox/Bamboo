// ============================================================
// Chat 页面 — 主聊天界面
// 展示消息列表、处理用户输入、管理消息的编辑/删除/重试/智能体切换
//
// 状态分层：
//   全局 (chatStore)   — messages、isStreaming
//   全局 (settingsStore) — shortcutConfig
//   本地 (useState)    — 输入框内容、编辑状态（仅 UI 级别，无需持久化）
//
// 扩展指南：
//   - Markdown 渲染：assistant 消息已通过 MarkdownContent 组件渲染
//   - 多会话：在 header 添加会话切换 UI，chatStore 按 sessionId 分片
//   - 消息搜索：在 messages 上方添加搜索框，用 useMemo 过滤展示
// ============================================================

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useChat } from '../hooks/useChat';
import { useScrollNavigation } from '../hooks/useScrollNavigation';
import { useFileImport } from '../hooks/useFileImport';
import { DEFAULT_AGENT_ID } from '../types';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { DEFAULT_MCP_CONFIG } from '../types';
import { getActivePath, getChildLeaves, getViewPath, getExecPath } from '../utils/treeUtils';

import { countStats } from '../utils/countStats';
import { mcpRegistry } from '../services/mcp';
import SessionList from '../components/SessionList';
import ScrollButtons from '../components/chat/ScrollButtons';
import ChatHeader from '../components/chat/ChatHeader';
import ChatInput from '../components/chat/ChatInput';
import RightPanel from '../components/chat/RightPanel';
import MessageItem from '../components/chat/MessageItem';
import Modal from '../components/Modal';
import styles from './Chat.module.css';
import { AttachIcon } from '../components/icons';
import ConversationTree from '../components/ConversationTree';

export default function Chat() {
  // ── 本地 UI 状态 ────────────────────────────────────────
  /**
   * 输入框当前文本。初始化时从 currentSession?.draft 恢复，确保页面切换后内容保留。
   * 输入变化时同步写入 store（updateSessionDraft），切换会话时各自记忆。
   * 发送成功后由 submitMessage 清空。
   */
  const [input, setInput] = useState(() => {
    // 从 store 直接读取当前会话的 draft，用于组件初始挂载时恢复
    const state = useChatStore.getState();
    const session = state.currentSessionId ? state.sessions[state.currentSessionId] : null;
    return session?.draft || '';
  });
  /** 当前正在编辑的消息 ID（null = 无编辑状态） */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 编辑框内暂存的文本内容 */
  const [editContent, setEditContent] = useState('');
  /**
   * 编辑框最小高度（px），取自原始消息气泡的高度
   * 防止编辑框切换时布局跳动
   */
  const [editMinHeight, setEditMinHeight] = useState<number | undefined>(undefined);
  /** 编辑框 textarea 引用，用于自动调整高度 */
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  /** 自动调整 textarea 高度匹配内容：最少 10 行，无上限，保留滚动条 */
  const autoResizeEditTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const minH = lineHeight * 10;
    el.style.height = `${Math.max(el.scrollHeight, minH)}px`;
    el.style.overflowY = 'auto';
  };

  // 编辑状态或内容变化时自动调整高度
  useEffect(() => {
    if (editingId && editTextareaRef.current) {
      autoResizeEditTextarea(editTextareaRef.current);
    }
  }, [editingId, editContent]);


  /** 手动展开了思考链的消息 ID 集合（流式中默认展开，结束后默认折叠） */
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set());

  /** 手动展开了完整参数的工具调用 ID 集合 */
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());

  /** 右侧栏是否折叠 */
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() => {
    return localStorage.getItem('rightPanelCollapsed') === 'true';
  });
  /** 右侧栏宽度 */
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const stored = localStorage.getItem('rightPanelWidth');
    return stored ? Math.max(240, Math.min(480, parseInt(stored, 10))) : 320;
  });

  /** 智能体提示词编辑弹窗状态 */
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editPromptContent, setEditPromptContent] = useState('');

  /** MCP 工具配置弹窗：记录正在编辑的工具 key，null 表示关闭 */
  const [editingMCPTool, setEditingMCPTool] = useState<string | null>(null);

  /** 对话总览树弹窗 */
  const [showTree, setShowTree] = useState(false);

  /** 多分支节点删除确认：存储待删除的消息 ID */
  const [deleteMultiBranchId, setDeleteMultiBranchId] = useState<string | null>(null);
  /** 批量多选删除确认：存储待批量删除的消息 ID 列表 */
  const [deleteMultiBatchIds, setDeleteMultiBatchIds] = useState<string[] | null>(null);

  /** 流式结束横幅：viewLeafId ≠ execLeafId 时提示用户查看生成结果 */
  const [streamEndBanner, setStreamEndBanner] = useState<{
    execLeafId: string;
    preview: string;
  } | null>(null);

  /** 智能体提示词是否已展开（过长时默认折叠） */
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  /** 智能体提示词是否超过显示阈值，需要截断 */
  const [shouldTruncatePrompt, setShouldTruncatePrompt] = useState(false);
  /** 提示词内容区域 ref，用于测量实际高度 */
  const promptContentRef = useRef<HTMLDivElement>(null);

  /** 主输入框 ref，用于发送后重置高度 */
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 底部输入区域 ref，用于动态计算按钮位置 */
  const inputContainerRef = useRef<HTMLDivElement>(null);

  // ── 全局状态 & Hook ─────────────────────────────────────
  const currentSessionId = useChatStore((state) => state.currentSessionId);

  // 🚀 性能优化：从 store 订阅原始 session（不含 draft 敏感度）
  // 通过 useMemo 仅对非 draft 字段做依赖比较，当只有 draft 变化（如打字中）时
  // 返回旧引用，避免级联触发 rawMessages / sessionStats 等重算和子组件重渲染
  const rawSession = useChatStore((state) =>
    state.currentSessionId ? state.sessions[state.currentSessionId] : null
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const currentSession = useMemo(() => rawSession, [
    currentSessionId,
    rawSession?.messageTree,
    rawSession?.execLeafId,
    rawSession?.viewLeafId,
    rawSession?.agentId,
    rawSession?.isStreaming,
    rawSession?.isAgentRunning,
    rawSession?.isQueued,
    rawSession?.isRateLimited,
    rawSession?.currentTool,
    rawSession?.title,
    rawSession?.rootMessageId,
    rawSession?.queuedHolderIds,
    rawSession?.abortController,
    rawSession?.fromGeWu,
    rawSession?.mcpConfig,
    rawSession?.llmConfig,
  ]);

  // 只订阅需要的方法，避免订阅整个 store
  const addMessage = useChatStore((state) => state.addMessage);
  const clearMessages = useChatStore((state) => state.clearMessages);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const deleteMessages = useChatStore((state) => state.deleteMessages);
  const editMessage = useChatStore((state) => state.editMessage);
  const updateMessageRole = useChatStore((state) => state.updateMessageRole);
  const truncateMessagesAfter = useChatStore((state) => state.truncateMessagesAfter);
  const switchBranch = useChatStore((state) => state.switchBranch);
  const syncSystemPrompts = useChatStore((state) => state.syncSystemPrompts);
  const updateSessionDraft = useChatStore((state) => state.updateSessionDraft);
  const updateSessionMCPConfig = useChatStore((state) => state.updateSessionMCPConfig);

  const rawMessages = currentSession ? getActivePath(currentSession) : [];
  const isStreaming = currentSession?.isStreaming || false;
  const isAgentRunning = currentSession?.isAgentRunning || false;
  const isQueued = currentSession?.isQueued || false;
  const isRateLimited = currentSession?.isRateLimited || false;
  const messages = rawMessages;
  /** 当前正在执行的工具信息（用于实时显示工具名称和参数） */
  const currentTool = currentSession?.currentTool ?? null;
  /** 是否正在处理中（流式输出 或 MCP 工具执行阶段 或排队中） */
  const isProcessing = isStreaming || isAgentRunning || isQueued;

  /** 视图路径消息 ID 集合（基于 viewLeafId，避免依赖 messages 数组引用） */
  const viewMessageIds = useMemo(
    () => new Set(getViewPath(currentSession!)),
    [currentSession?.viewLeafId, currentSession?.messageTree]
  );

  /** 执行路径消息 ID 集合（流式期间可能与视图路径不同） */
  const execMessageIds = useMemo(
    () => new Set(getExecPath(currentSession!)),
    [currentSession?.execLeafId, currentSession?.messageTree]
  );

  /** 🚀 性能优化：流式过程中增量计算词数/token，避免每次 chunk 全量遍历历史消息
   *
   *  策略：
   *    - 流式进行中（isStreaming=true，最后一条消息 content 变长）：只算新增 delta
   *    - 添加消息：只算新增的那条消息
   *    - 删除/截断/切换会话：全量重算（频率低，可接受）
   */
  const sessionStatsAccRef = useRef({ words: 0, tokens: 0, isExact: false, lastMsgCount: 0, lastContentLen: 0 });
  const sessionStats = useMemo(() => {
    const acc = sessionStatsAccRef.current;
    const msgCount = messages.length;
    const lastMsg = msgCount > 0 ? messages[msgCount - 1] : null;
    const lastContent = lastMsg?.content ?? '';

    if (isStreaming && msgCount === acc.lastMsgCount && msgCount > 0) {
      // ── 流式进行中，最后一条消息持续变长：只算新增字符的 delta ──
      if (lastContent.length > acc.lastContentLen) {
        const delta = lastContent.slice(acc.lastContentLen);
        const s = countStats(delta);
        acc.words += s.words;
        acc.tokens += s.tokens;
        acc.lastContentLen = lastContent.length;
        acc.isExact = false; // 流式未结束，token 不精确
      }
      return { words: acc.words, tokens: acc.tokens, isExact: false };
    }

    if (msgCount > acc.lastMsgCount && acc.lastMsgCount > 0) {
      // ── 新增了消息（非流式追加，如 tool 结果）：只算新增消息 ──
      let deltaWords = 0, deltaTokens = 0;
      for (let i = acc.lastMsgCount; i < msgCount; i++) {
        const s = countStats(messages[i].content);
        deltaWords += s.words;
        deltaTokens += s.tokens;
      }
      const lastUsage = [...messages].reverse().find((m) => m.tokenUsage)?.tokenUsage;
      acc.words += deltaWords;
      acc.tokens = lastUsage?.totalTokens ?? acc.tokens + deltaTokens;
      acc.lastMsgCount = msgCount;
      acc.lastContentLen = lastContent.length;
      acc.isExact = !!lastUsage;
      return { words: acc.words, tokens: acc.tokens, isExact: acc.isExact };
    }

    // ── 消息减少（删除/截断）/ 会话切换 / 首次计算：全量准确重算 ──
    let words = 0, tokens = 0;
    for (const msg of messages) {
      words += countStats(msg.content).words;
    }
    const lastUsage = [...messages].reverse().find((m) => m.tokenUsage)?.tokenUsage;
    tokens = lastUsage?.totalTokens ?? messages.reduce((sum, m) => sum + countStats(m.content).tokens, 0);
    acc.words = words;
    acc.tokens = tokens;
    acc.lastMsgCount = msgCount;
    acc.lastContentLen = lastContent.length;
    acc.isExact = !!lastUsage;
    return { words, tokens, isExact: !!lastUsage };
  }, [messages, isStreaming]);

  /** 最后一个有 toolCalls 的 assistant 消息 ID（从执行路径计算，用于 Agent 执行期间保持 toolCalls 展开） */
  const lastToolCallMsgId = useMemo(() => {
    if (!currentSession) return undefined;
    const execPath = getExecPath(currentSession);
    for (let i = execPath.length - 1; i >= 0; i--) {
      const msg = currentSession.messageTree[execPath[i]];
      if (msg && msg.role === 'assistant' && msg.toolCalls?.length) {
        return msg.id;
      }
    }
    return undefined;
  }, [currentSession?.execLeafId, currentSession?.messageTree]);

  const { shortcutConfig, appConfig, roles } = useSettingsStore();
  const updateRole = useSettingsStore((state) => state.updateRole);

  // 当前会话绑定的智能体及其系统提示词
  const currentRole = roles.find((r) => r.id === currentSession?.agentId);
  const activeSystemPrompt = currentRole?.systemPrompt?.trim() || '';
  // MCP 配置直接从当前会话读取（创建时已从智能体快照，独立不干扰）
  const effectiveMcpConfig = useMemo(
    () => currentSession?.mcpConfig ?? { ...DEFAULT_MCP_CONFIG },
    [currentSession?.mcpConfig]
  );
  const { sendMessage, retryFromMessage, stopStreaming, streamNewResponse } = useChat();

  // ── 选中文本右键菜单（格物）：依赖 sendMessage，放在 useChat 之后 ──
  /** 关闭选中文本右键菜单 */
  // ── 格物：选中文本 → 创建新对话并提问 ────────────────
  const handleGeWu = useCallback(async (text: string) => {
    // 清除选区（避免视觉残留）
    window.getSelection()?.removeAllRanges();
    // 创建新会话（默认智能体 = "随便聊聊"）
    const newSessionId = useChatStore.getState().createSession(DEFAULT_AGENT_ID);
    if (!newSessionId) return;
    // 标记为格物会话（自动命名时会加"致知："前缀）
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [newSessionId]: { ...state.sessions[newSessionId], fromGeWu: true },
      },
    }));
    // 等 React 完成 session 切换渲染后，再发送消息
    await new Promise((r) => setTimeout(r, 0));
    sendMessage(`请帮我理解以下内容。如果是一个词语或几个字，请说明含义，生僻字请标注拼音；如果是一段或多段文字，请解释其背景和含义：\n\n"""\n${text}\n"""`);

  }, [sendMessage]);

  /** 监听 Electron 原生右键菜单的"格物"点击事件 */
  useEffect(() => {
    const unsub = window.electronAPI?.onGeWu?.((text: string) => {
      handleGeWu(text);
    });
    return () => unsub?.();
  }, [handleGeWu]);

  const {
    containerRef,
    messagesEndRef,
    autoScroll,
    autoScrollLocked,
    scrollToTop,
    scrollToPrevUser,
    scrollToNextUser,
    toggleAutoScroll,
    scrollToBottom,
    saveScrollPosition,
    restoreScrollPosition,
  } = useScrollNavigation({
    messages,
    isStreaming,
    isAgentRunning,
    currentSessionId,
    viewLeafId: currentSession?.viewLeafId,
    isTreeVisible: showTree,
  });

  /**
   * 构建 toolCallId → tool 结果消息的映射。
   * 用于在聊天视图中将 tool 结果内联渲染到父 assistant 气泡中。
   * 使用 toolCallId（而非 parentId）作为键，因为 addMessage 在连续写入
   * 多条 tool 消息时，execLeafId 会指向前一条 tool 消息，导致后续 tool
   * 消息的 parentId 链式偏移。
   */
  const { toolResultByCallId, inlinedToolCallIds } = useMemo(() => {
    const resultMap = new Map<string, Message>();
    const inlined = new Set<string>();

    // 第一遍：收集所有 assistant 消息携带的 toolCall ID 集合
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          inlined.add(tc.id);
        }
      }
    }

    // 第二遍：将 tool 结果消息按 toolCallId 索引
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolResult?.toolCallId) {
        resultMap.set(msg.toolResult.toolCallId, msg);
      }
    }

    return { toolResultByCallId: resultMap, inlinedToolCallIds: inlined };
  }, [messages]);

  /** 上一次渲染时的 isStreaming 状态，用于检测流式结束事件 */
  const prevIsStreamingRef = useRef(false);
  // ── 副作用 ──────────────────────────────────────────────

  /**
   * 监听底部输入区域高度变化，更新 CSS 变量 --input-area-height，
   * 使右侧浮动按钮位置自动跟随输入框高度变化。
   */
  useEffect(() => {
    // showTree 为 true 时 inputContainer 不渲染，ref 为 null
    const el = inputContainerRef.current;
    if (!el) return;
    const updateHeight = () => {
      const h = el.offsetHeight;
      el.style.setProperty('--input-area-height', `${h}px`);
      // 同时设置到 container 上，供 fixed 定位按钮使用（CSS 变量继承）
      const container = el.closest(`.${styles.container}`);
      if (container instanceof HTMLElement) {
        container.style.setProperty('--input-area-height', `${h}px`);
      }
    };
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTree]);

  /**
   * 切换会话时恢复输入框草稿并重置 textarea 高度。
   */
  useEffect(() => {
    // 切换会话时，从 store 恢复该会话的输入框草稿
    const state = useChatStore.getState();
    const session = state.currentSessionId ? state.sessions[state.currentSessionId] : null;
    setInput(session?.draft || '');
    // 重置 textarea 高度
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [currentSessionId]);

  /** 流式结束后自动聚焦输入框，若视图与执行分支分离则显示提示横幅 */
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming) {
      inputRef.current?.focus();

      // 检测视图是否与执行分支分离
      if (currentSession &&
          currentSession.viewLeafId !== currentSession.execLeafId &&
          currentSession.execLeafId) {
        const execMsg = currentSession.messageTree[currentSession.execLeafId];
        const rawPreview = execMsg?.content ?? '';
        const preview = rawPreview
          ? rawPreview.replace(/\n/g, ' ').slice(0, 50) + (rawPreview.length > 50 ? '…' : '')
          : '';
        setStreamEndBanner({
          execLeafId: currentSession.execLeafId,
          preview,
        });
      }
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // ── 流式结束横幅自动消失条件 ──────────────────────────

  /** 条件 A：用户手动切回执行分支 → 横幅自动消失 */
  useEffect(() => {
    if (streamEndBanner && currentSession?.viewLeafId === streamEndBanner.execLeafId) {
      setStreamEndBanner(null);
    }
  }, [currentSession?.viewLeafId, streamEndBanner]);

  /** 条件 B：新一轮流式开始 → 横幅自动消失 */
  useEffect(() => {
    if (isStreaming) setStreamEndBanner(null);
  }, [isStreaming]);

  /** 条件 C：切换会话 → 横幅自动消失 */
  useEffect(() => {
    setStreamEndBanner(null);
  }, [currentSessionId]);

  /**
   * Escape 键双重职责：
   *   流式接收中 → 停止生成
   *   编辑模式中 → 取消编辑
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isProcessing) {
        stopStreaming();
      } else if (editingId) {
        setEditingId(null);
        setEditContent('');
        setEditMinHeight(undefined);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isProcessing, editingId, stopStreaming]);

  /** 弹窗打开时初始化编辑内容 */
  useEffect(() => {
    if (editingPrompt && currentRole) {
      setEditPromptContent(currentRole.systemPrompt || '');
    }
  }, [editingPrompt, currentRole]);

  /** 检测提示词内容是否超过 6 行，决定是否显示展开按钮 */
  useEffect(() => {
    if (!promptContentRef.current || !activeSystemPrompt) {
      setShouldTruncatePrompt(false);
      return;
    }
    const el = promptContentRef.current;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22.4;
    setShouldTruncatePrompt(el.scrollHeight > lineHeight * 6 + 2);
  }, [activeSystemPrompt]);

  /** 切换智能体时重置展开状态 */
  useEffect(() => {
    setIsPromptExpanded(false);
  }, [currentSession?.agentId]);

  // ── 输入框操作 ──────────────────────────────────────────

  /** 提交消息：清空输入框和 draft、重置高度、调用 sendMessage */
  const submitMessage = async () => {
    if (!input.trim() || isProcessing) return;
    const message = input.trim();
    setInput('');
    // 清空 draft（发送成功后不再需要保留输入内容）
    if (currentSessionId) {
      updateSessionDraft(currentSessionId, '');
    }
    // 重置自动扩展的 textarea 高度
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    await sendMessage(message);
  };

  // ── 文件导入（统一由 useFileImport hook 管理） ──────────
  // 所有文件选择、拖放、读取逻辑均收拢在 hooks/useFileImport.ts 中

  const { fileInputRef, isDragging, handleFileImport, dragCallbacks } =
    useFileImport({
      sessionId: currentSessionId,
      sessionTitle: currentSession?.title || '',
      onAddMessage: addMessage,
    });

  // ── 右侧面板宽度调整 ────────────────────────────────────

  const toggleRightPanel = () => {
    const next = !isRightPanelCollapsed;
    setIsRightPanelCollapsed(next);
    localStorage.setItem('rightPanelCollapsed', String(next));
  };

  const handleRightPanelResize = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return;
    if (isRightPanelCollapsed) return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = rightPanelWidth;

    // 添加 resizing class，禁用 transition
    const rightPanel = document.querySelector(`.${styles.rightPanel}`) as HTMLElement;
    if (rightPanel) rightPanel.classList.add(styles.resizing);
    const container = document.querySelector(`.${styles.container}`) as HTMLElement;

    let lastX = startX; // onMouseMove 实时更新，供 onMouseUp 使用

    const onMouseMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      // 右侧面板向左拖拽增加宽度
      const newWidth = Math.max(240, Math.min(480, startWidth + (startX - ev.clientX)));
      setRightPanelWidth(newWidth);
      // 直接更新 CSS 变量，跳过 React re-render，使滚动按钮位置实时跟随
      container?.style.setProperty('--right-panel-width', `${newWidth}px`);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';

      // 拖拽结束时保存宽度：用 lastX 实时计算最终宽度
      const finalWidth = Math.max(240, Math.min(480, startWidth + (startX - lastX)));
      localStorage.setItem('rightPanelWidth', String(finalWidth));

      // 移除 resizing class，恢复 transition
      if (rightPanel) rightPanel.classList.remove(styles.resizing);
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // ── 消息编辑操作 ────────────────────────────────────────

  /** 取消编辑，清除所有编辑相关临时状态 */
  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditMinHeight(undefined);
  };

  /**
   * 进入编辑模式
   * 记录原始消息气泡高度作为编辑框 minHeight，保持视觉稳定
   * system 消息的编辑直接弹出智能体提示词编辑窗
   */
  const doEdit = (id: string) => {
    // 编辑模式仅打开编辑框，不修改 store，流式期间也安全
    // 提交时的守卫在 handleEditSubmit 中
    // 优先从活跃路径查找，总览树触发的编辑可能不在活跃路径上，回退到 messageTree
    let msg = messages.find((m) => m.id === id);
    if (!msg && currentSession) {
      msg = currentSession.messageTree[id] ?? null;
    }
    if (!msg) return;
    // system 消息编辑 → 打开智能体提示词编辑窗
    if (msg.role === 'system') {
      setEditingPrompt(true);
      if (currentRole) {
        setEditPromptContent(currentRole.systemPrompt || '');
      }
      return;
    }
    const el = document.getElementById(`msg-${id}`);
    setEditMinHeight(el ? el.offsetHeight : undefined);
    setEditingId(id);
    setEditContent(msg.content);
  };

  /** 判断某消息是否有多个直接子分支 */
  const hasMultiBranch = (id: string): boolean => {
    if (!currentSession) return false;
    const tree = currentSession.messageTree;
    const children = Object.values(tree).filter(m => m.parentId === id);
    return children.length > 1;
  };

  /** 删除指定消息（流式期间仅阻止执行路径上的删除） */
  const doDelete = (id: string) => {
    if (!currentSessionId) return;
    // 流式期间：禁止删除执行路径上的消息
    if (isProcessing && currentSession) {
      const execPath = getExecPath(currentSession);
      if (execPath.includes(id)) return;
    }
    // 如果是多分支节点，弹窗确认
    if (hasMultiBranch(id)) {
      setDeleteMultiBranchId(id);
      return;
    }
    deleteMessage(currentSessionId, id);
  };

  /** 批量删除消息（树形总览中的多选删除，流式期间自动过滤执行路径节点） */
  const doDeleteMultiple = (ids: string[]) => {
    if (!currentSessionId || ids.length === 0) return;
    // 过滤：排除 system 根节点
    const tree = currentSession?.messageTree ?? {};
    let validIds = ids.filter((id) => {
      const msg = tree[id];
      if (!msg) return false;
      if (msg.role === 'system' && msg.parentId === null) return false;
      return true;
    });

    // 流式期间：排除执行路径上的节点
    if (isProcessing && currentSession) {
      const execPath = getExecPath(currentSession);
      validIds = validIds.filter((id) => !execPath.includes(id));
    }

    if (validIds.length === 0) return;

    // 如果有任何选中节点是多分支节点，弹窗确认
    const hasAnyMultiBranch = validIds.some((id) => hasMultiBranch(id));
    if (hasAnyMultiBranch) {
      setDeleteMultiBatchIds(validIds);
      return;
    }
    deleteMessages(currentSessionId, validIds);
  };

  /** 确认删除多分支节点 */
  const confirmMultiBranchDelete = () => {
    if (!currentSessionId || !deleteMultiBranchId) return;
    deleteMessage(currentSessionId, deleteMultiBranchId);
    setDeleteMultiBranchId(null);
  };

  /** 确认批量删除（含多分支节点） */
  const confirmMultiBatchDelete = () => {
    if (!currentSessionId || !deleteMultiBatchIds) return;
    deleteMessages(currentSessionId, deleteMultiBatchIds);
    setDeleteMultiBatchIds(null);
  };

  /**
   * 重新执行单个工具调用。
   * 用新结果原地更新原 tool 消息的 content 和 toolResult，不删除重建，
   * 避免消息 id 变化导致树结构偏移或出现虚假分支。
   */
  const handleRerunTool = async (toolCallId: string, toolName: string, toolArgs: string) => {
    if (!currentSessionId) return;
    const sessionId = currentSessionId;

    // 找到旧的 tool 结果消息
    const oldToolMsg = messages.find(
      (m) => m.role === 'tool' && m.toolResult?.toolCallId === toolCallId
    );
    if (!oldToolMsg) return;

    // 重新执行工具（权限检查使用 sessionId 从会话配置读取）
    try {
      const { result, isError } = await mcpRegistry.execute(
        toolName,
        toolArgs,
        null,
        sessionId,
      );
      // 原地更新：只改 content 和 toolResult，id 和 parentId 不变
      editMessage(sessionId, oldToolMsg.id, result, {
        toolCallId,
        name: toolName,
        result,
        isError,
      });
    } catch (err) {
      console.error(`[RerunTool] 工具 ${toolName} 重新执行失败:`, err);
      editMessage(sessionId, oldToolMsg.id,
        `[重新执行异常] ${err instanceof Error ? err.message : String(err)}`,
        {
          toolCallId,
          name: toolName,
          result: `[重新执行异常] ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      );
    }
  };

  /** 流式结束横幅：点击跳转到执行分支 */
  const handleBannerClick = () => {
    if (!currentSessionId || !streamEndBanner) return;
    useChatStore.getState().switchBranch(currentSessionId, streamEndBanner.execLeafId);
    setStreamEndBanner(null);
  };

  /** 重试指定消息（处理中禁用） */
  const doRetry = (id: string) => {
    if (isProcessing) return;
    // 优先从活跃路径查找，总览树触发的重试可能不在活跃路径上，回退到 messageTree
    let msg = messages.find((m) => m.id === id);
    if (!msg && currentSession) {
      msg = currentSession.messageTree[id] ?? null;
    }
    if (!msg) return;
    retryFromMessage(msg.id, msg.role, msg.content);
  };

  /** 继续：保留此消息及以上内容，截断后续消息重新请求 LLM */
  const doContinueFrom = (id: string) => {
    if (isProcessing || !currentSessionId) return;
    // 保留目标消息及之前的所有消息，删除之后的消息
    truncateMessagesAfter(currentSessionId, id);
    // 立刻将当前上下文发送给 LLM 获取新回复
    streamNewResponse(currentSessionId);
  };

  /**
   * 提交编辑内容
   *
   * resend=true（默认）：user 消息截断后续并重新发送；assistant/system 仅更新文本
   * resend=false：所有消息类型仅原地更新文本，不触发新请求
   */
  const handleEditSubmit = (id: string, resend = true) => {
    if (!currentSessionId) return;
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;

    // 流式期间：禁止所有 user 消息的"保存并重发"（streamNewResponse 会因 isStreaming 而失败）
    if (resend && msg.role === 'user' && isProcessing) return;

    if (resend && msg.role === 'user') {
      // ================================================================
      // 分支编辑：在父节点下创建新用户消息（带编辑内容）作为新分支，
      // 保留原消息不变（可在分支总览中回溯）
      // ================================================================
      const store = useChatStore.getState();
      const parentId = msg.parentId!; // user 消息必然有父节点
      // ① 在父节点下创建新用户消息（编辑后的内容），execLeafId 自动指向它
      store.addChildMessage(currentSessionId, parentId, 'user', editContent);
      // ② 发起流式请求（doStream 内部会统一创建 assistant 占位，不在此处提前创建，
      //    否则空 assistant 会出现在 getActivePath 构建的 API 上下文中，导致部分服务商异常）
      streamNewResponse(currentSessionId);
    } else {
      editMessage(currentSessionId, id, editContent);
    }
    setEditingId(null);
    setEditContent('');
    setEditMinHeight(undefined);
  };

  // ── 全局快捷键：作用于最后一条消息 ───────────────────────

  /** 最后一条消息的 ID，快捷键默认操作此消息 */
  const lastId = messages.at(-1)?.id;

  /** 复制消息内容到剪贴板 */
  const doCopy = (id: string) => {
    // 优先从活跃路径查找，总览树触发的复制可能不在活跃路径上，回退到 messageTree
    let msg = messages.find((m) => m.id === id);
    if (!msg && currentSession) {
      msg = currentSession.messageTree[id] ?? null;
    }
    if (!msg) return;
    const text = msg.content;
    if (!text) return;
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('[Copy] 复制失败:', err);
    });
  };

  /** 拦截浏览器默认复制行为：确保手动选中文本 Ctrl+C 时只复制纯文本，不带字体/颜色等格式 */
  const handleCopyPlainText = useCallback((e: React.ClipboardEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (!text) return;
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', '');
    e.preventDefault();
  }, []);

  useKeyboardShortcuts(shortcutConfig, {
    onEdit:             () => lastId && doEdit(lastId),
    onDelete:           () => {
      if (!lastId || !currentSession) return;
      // 如果 lastId 指向 tool 消息，往上找到对应的 assistant 再删除，
      // 避免只删单条 tool 导致 toolCalls 引用悬空。
      let targetId = lastId;
      const tree = currentSession.messageTree;
      const lastMsg = tree[lastId];
      if (lastMsg && lastMsg.role === 'tool') {
        // 沿 parentId 向上找到最近的 assistant（带 toolCalls）
        let cur = lastMsg.parentId;
        while (cur) {
          const m = tree[cur];
          if (!m) break;
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            targetId = cur;
            break;
          }
          cur = m.parentId;
        }
      }
      doDelete(targetId);
    },
    onRetry:            () => lastId && doRetry(lastId),
    onContinueFrom:     () => lastId && doContinueFrom(lastId),
    onCopy:             () => lastId && doCopy(lastId),
    onClearConversation:() => { if (!isProcessing && currentSessionId) clearMessages(currentSessionId); },
  });

  // ── 总览树操作包装函数 ──────────────────────────────────

  /**
   * 切换到目标消息所在分支并关闭总览树。
   * 用于编辑/重试/继续等需要回到消息列表 UI 的操作。
   */
  const switchToMessageAndCloseTree = useCallback((messageId: string) => {
    if (!currentSession) return;
    let didSwitch = false;
    if (!viewMessageIds.has(messageId)) {
      const messageTree = currentSession.messageTree;
      const leaves = getChildLeaves(messageTree, messageId);
      if (leaves.length > 0) {
        switchBranch(currentSession.id, leaves[0]);
      } else {
        switchBranch(currentSession.id, messageId);
      }
      didSwitch = true;
    }
    setShowTree(false);
    if (didSwitch) {
      // 🐛 修复：跨分支时目标消息可能不在滚动视野中，
      // 直接定位到目标消息（与 onNavigate 一致），不恢复旧分支的会话级位置
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      });
    } else {
      restoreScrollPosition();
    }
  }, [currentSession, viewMessageIds, switchBranch, restoreScrollPosition]);

  // ── 渲染 ────────────────────────────────────────────────

  return (
    <>
      <div
        className={styles.container}
        style={{
          '--right-panel-width': isRightPanelCollapsed ? '0px' : `${rightPanelWidth}px`,
          '--input-area-height': '0px'
        } as React.CSSProperties}
      >
      {/* ── 左侧会话列表 ─────────────────────────────────── */}
      <SessionList />

      {/* ── 中间消息区域 ─────────────────────────────────── */}
      <div
        className={styles.chatArea}
        {...dragCallbacks}
      >
        {isDragging && (
          <div className={styles.dragOverlay}>
            <div className={styles.dragOverlayContent}>
              <AttachIcon size={32} strokeWidth={1.8} />
              <span className={styles.dragOverlayTitle}>松开以导入文件</span>
              <span className={styles.dragOverlayHint}>支持 PDF 及多种文本格式，可同时导入多个文件</span>
            </div>
          </div>
        )}
        {/* ── 顶部 Header ──────────────────────────────────── */}
        <ChatHeader
          title={currentSession?.title || 'LLM Chat Demo'}
          showTree={showTree}
          sessionId={currentSessionId!}
          onToggleTree={() => {
            if (!showTree) {
              saveScrollPosition();
            } else {
              restoreScrollPosition();
            }
            setShowTree(v => !v);
          }}
          onClearConversation={() => currentSessionId && clearMessages(currentSessionId)}
        />

      {/* ── 消息列表区域（或树总览） ──────────────────────── */}
      <div className={`${styles.messagesContainer} ${showTree ? styles.treeMode : ''} ${autoScrollLocked ? styles.scrollLocked : ''}`} ref={containerRef} onCopy={handleCopyPlainText}>
        {showTree ? (
          <ConversationTree
            key={currentSessionId}
            messageTree={currentSession?.messageTree ?? {}}
            rootMessageId={currentSession?.rootMessageId ?? null}
            currentMessageId={messages.at(-1)?.id}
            isStreaming={isStreaming}
            viewMessageIds={viewMessageIds}
            execMessageIds={execMessageIds}
            onClose={() => {
              setShowTree(false);
              restoreScrollPosition();
            }}
            onEdit={(id) => { switchToMessageAndCloseTree(id); doEdit(id); }}
            onRetry={(id) => { switchToMessageAndCloseTree(id); doRetry(id); }}
            onCopy={doCopy}
            onContinueFrom={(id) => { switchToMessageAndCloseTree(id); doContinueFrom(id); }}
            onDelete={doDelete}
            onDeleteMultiple={doDeleteMultiple}
            onBranchSwitch={(sid, leafId) => switchBranch(sid, leafId)}
            currentSessionId={currentSessionId}
            onNavigate={(messageId) => {
              // 如果点击的节点不在当前活跃路径上（属于非活跃分支），
              // 自动切换到该分支
              if (!viewMessageIds.has(messageId) && currentSession) {
                const messageTree = currentSession.messageTree;
                const viewPath = getViewPath(currentSession);
                const leaves = getChildLeaves(messageTree, messageId);
                if (leaves.length > 0) {
                  // 中间节点：如果当前视图叶子已在该子树中，无需切换
                  if (viewPath.includes(messageId)) {
                    // 已在正确分支，无需切换
                  } else {
                    switchBranch(currentSession.id, leaves[0]);
                  }
                } else {
                  // 叶子节点：直接切换
                  switchBranch(currentSession.id, messageId);
                }
              }
              setShowTree(false);
              requestAnimationFrame(() => {
                const el = document.getElementById(`msg-${messageId}`);
                if (el) {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.classList.add('treeNavigateHighlight');
                  setTimeout(() => el.classList.remove('treeNavigateHighlight'), 1500);
                }
              });
            }}
          />
        ) : (
          <>
        <ScrollButtons
          hasMessages={messages.length > 0}
          scrollToTop={scrollToTop}
          scrollToPrevUser={scrollToPrevUser}
          scrollToNextUser={scrollToNextUser}
          isStreaming={isStreaming}
          isAgentRunning={isAgentRunning}
          autoScroll={autoScroll}
          toggleAutoScroll={toggleAutoScroll}
          scrollToBottom={scrollToBottom}
        />

        {/* 流式结束横幅：视图与执行分支分离时提示 */}
        {streamEndBanner && (
          <div className={styles.streamEndBanner}>
            <span className={styles.streamEndBannerIcon}>✅</span>
            <span className={styles.streamEndBannerText}>
              生成完成
              {streamEndBanner.preview && (
                <span className={styles.streamEndBannerPreview}>
                  — {streamEndBanner.preview}
                </span>
              )}
            </span>
            <button className={styles.streamEndBannerAction} onClick={handleBannerClick}>
              点击查看
            </button>
            <button
              className={styles.streamEndBannerDismiss}
              onClick={() => setStreamEndBanner(null)}
              title="关闭"
            >
              ✕
            </button>
          </div>
        )}

        <div className={styles.messagesList}>
            {messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                isLastMessage={isStreaming && message.id === messages.at(-1)?.id}
                isEditing={editingId === message.id}
                editContent={editContent}
                editMinHeight={editMinHeight}
                editTextareaRef={editTextareaRef}
                isStreaming={isStreaming}
                isAgentRunning={isAgentRunning}
                isQueued={isQueued}
                lastToolCallMsgId={lastToolCallMsgId}
                expandedReasoning={expandedReasoning}
                onToggleReasoning={(id) => setExpandedReasoning((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                expandedToolCalls={expandedToolCalls}
                onToggleToolCall={(id) => setExpandedToolCalls((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                appConfig={appConfig}
                shortcutConfig={shortcutConfig}
                currentSessionId={currentSessionId}
                onEditStart={doEdit}
                onEditContentChange={setEditContent}
                onEditKeyDown={() => {}}
                onEditSubmit={handleEditSubmit}
                onCancelEdit={cancelEdit}
                onRoleChange={(sid, mid, role) => updateMessageRole(sid, mid, role)}
                onRetry={doRetry}
                onCopy={doCopy}
                onContinueFrom={doContinueFrom}
                onDelete={doDelete}
                onBranchSwitch={(sid, leafId) => switchBranch(sid, leafId)}
                viewLeafId={currentSession?.viewLeafId}
                systemRoleName={currentRole?.name}
                autoResizeEditTextarea={autoResizeEditTextarea}
                childToolMessages={toolResultByCallId}
                inlinedToolCallIds={inlinedToolCallIds}
                onRerunTool={handleRerunTool}
              />
            ))}
            {/* 自动滚动锚点 */}
            <div ref={messagesEndRef} />
          </div>
          </>
        )}
      </div>

      {/* ── 底部输入区域（树模式下隐藏） ────────────────── */}
      {!showTree && (
        <ChatInput
          inputContainerRef={inputContainerRef}
          messagesCount={messages.length}
          sessionStats={sessionStats}
          input={input}
          inputRef={inputRef}
          fileInputRef={fileInputRef}
          isProcessing={isProcessing}
          isQueued={isQueued}
          isRateLimited={isRateLimited}
          isAgentRunning={isAgentRunning}
          isStreaming={isStreaming}
          currentToolName={currentTool?.name}
          onInputChange={(value) => {
            setInput(value);
            if (currentSessionId) {
              updateSessionDraft(currentSessionId, value);
            }
          }}
          onSubmit={submitMessage}
          onKeyDown={() => {}}
          onFileImport={handleFileImport}
          onStop={stopStreaming}
        />
      )}
      </div>

      {/* ── 右侧信息面板 ─────────────────────────────────── */}
      <RightPanel
        isCollapsed={isRightPanelCollapsed}
        width={rightPanelWidth}
        role={currentRole}
        activeSystemPrompt={activeSystemPrompt}
        effectiveMcpConfig={effectiveMcpConfig}
        appConfig={appConfig}
        currentSessionId={currentSessionId}
        editingPrompt={editingPrompt}
        editPromptContent={editPromptContent}
        editingMCPTool={editingMCPTool}
        isPromptExpanded={isPromptExpanded}
        shouldTruncatePrompt={shouldTruncatePrompt}
        promptContentRef={promptContentRef}
        onToggleCollapse={toggleRightPanel}
        onResize={handleRightPanelResize}
        onOpenPromptEdit={() => setEditingPrompt(true)}
        onClosePromptEdit={() => setEditingPrompt(false)}
        onEditPromptContentChange={setEditPromptContent}
        onSavePrompt={() => {
          if (currentRole) {
            updateRole(currentRole.id, { systemPrompt: editPromptContent });
            syncSystemPrompts(currentRole.id);
            setEditingPrompt(false);
          }
        }}
        onTogglePromptExpand={() => setIsPromptExpanded(v => !v)}
        onOpenMCPToolEdit={setEditingMCPTool}
        onCloseMCPToolEdit={() => setEditingMCPTool(null)}
        onUpdateMcpConfig={(config) => {
          if (currentSessionId) {
            updateSessionMCPConfig(currentSessionId, config);
          }
        }}
        onQuickPhraseClick={(text) => {
          if (editingId) {
            // 正在编辑气泡：在光标位置插入
            const el = editTextareaRef.current;
            if (el) {
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const newValue = editContent.slice(0, start) + text + editContent.slice(end);
              setEditContent(newValue);
              // 恢复焦点并将光标放到插入文本之后
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(start + text.length, start + text.length);
              });
            }
          } else {
            // 否则在输入栏光标位置插入
            const el = inputRef.current;
            if (el) {
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const newValue = input.slice(0, start) + text + input.slice(end);
              setInput(newValue);
              if (currentSessionId) {
                updateSessionDraft(currentSessionId, newValue);
              }
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(start + text.length, start + text.length);
              });
            }
          }
        }}
        onSelectFolder={window.electronAPI ? () => window.electronAPI!.selectFolder() : undefined}
      />
    </div>

      {/* ── 多分支节点删除确认弹窗 ─────────────────── */}
      <Modal
        open={!!deleteMultiBranchId}
        onClose={() => setDeleteMultiBranchId(null)}
        title="删除多分支节点"
        maxWidth="380px"
        footer={
          <>
            <button className={styles.modalCancel} onClick={() => setDeleteMultiBranchId(null)}>取消</button>
            <button className={styles.modalConfirm} onClick={confirmMultiBranchDelete}>确认删除</button>
          </>
        }
      >
        <p className={styles.modalBody}>
          该消息有多个分支，删除后将同时删除所有子分支及其后续消息。此操作不可撤销，确定继续吗？
        </p>
      </Modal>

      {/* ── 批量删除确认弹窗（含多分支节点） ──────── */}
      <Modal
        open={!!deleteMultiBatchIds}
        onClose={() => setDeleteMultiBatchIds(null)}
        title={`批量删除 ${deleteMultiBatchIds?.length ?? 0} 个节点`}
        maxWidth="380px"
        footer={
          <>
            <button className={styles.modalCancel} onClick={() => setDeleteMultiBatchIds(null)}>取消</button>
            <button className={styles.modalConfirm} onClick={confirmMultiBatchDelete}>确认删除</button>
          </>
        }
      >
        <p className={styles.modalBody}>
          选中的节点中包含多分支节点，删除后将同时删除其所有子分支及后续消息。此操作不可撤销，确定继续吗？
        </p>
      </Modal>

    </>
  );
}