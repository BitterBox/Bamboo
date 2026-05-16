// ============================================================
// SessionList — 会话列表组件（按智能体分组）
// 每个智能体作为可折叠的会话组，每组有独立的"新建会话"按钮
// 支持：可变宽度拖拽 / 隐藏式右边界折叠柄 / 流式加载指示器
// 支持：拖拽会话排序 / 拖拽会话到不同智能体组
// ============================================================

import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { Reorder, AnimatePresence, motion } from 'framer-motion';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { DEFAULT_AGENT_ID, type Role } from '../types';
import styles from './SessionList.module.css';
import Modal from './Modal';
import { ChevronIcon } from './icons';
import { autoNameSession } from '../services/autoNameService';

// ============================================================
// SessionReorderGroup — 隔离会话拖拽排序状态
// 拖拽过程中只更新本地 state，onDragEnd 才提交到全局 store
// 避免频繁触发全局重渲染导致的动画卡顿
// ============================================================

function SessionReorderGroup({
  agentId,
  sessionIds,
  isStarred,
  renderContent,
  itemClassName,
  onItemClick,
  onItemContextMenu,
}: {
  agentId: string;
  sessionIds: string[];
  isStarred: boolean;
  renderContent: (sessionId: string) => React.ReactNode;
  itemClassName: (sessionId: string) => string;
  onItemClick: (sessionId: string) => void;
  onItemContextMenu: (e: React.MouseEvent, sessionId: string) => void;
}) {
  const [localOrder, setLocalOrder] = useState(sessionIds);
  const reorderSessions = useChatStore((s) => s.reorderSessions);

  // 元素集合签名（排序后 join），用于检测增删（不响应纯排序变化）
  const setSig = useMemo(() => [...sessionIds].sort().join(','), [sessionIds]);

  // 外部数据变化（新建/删除/关注切换）时同步，拖拽中不响应
  useEffect(() => {
    const localSet = new Set(localOrder);
    const externalSet = new Set(sessionIds);
    if (localSet.size !== externalSet.size || [...localSet].some((id) => !externalSet.has(id))) {
      setLocalOrder(sessionIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSig]);

  const handleDragEnd = () => {
    const store = useChatStore.getState();
    const agentSessions = store.sessionOrder.filter((id) => store.sessions[id]?.agentId === agentId);
    const starred = agentSessions.filter((id) => store.sessions[id]?.isStarred);
    const unstarred = agentSessions.filter((id) => !store.sessions[id]?.isStarred);
    reorderSessions(agentId, isStarred ? localOrder : starred, isStarred ? unstarred : localOrder);
  };

  if (localOrder.length === 0) return null;

  return (
    <Reorder.Group as="div" axis="y" values={localOrder} onReorder={setLocalOrder}>
      {localOrder.map((sessionId) => (
        <Reorder.Item
          as="div"
          key={sessionId}
          value={sessionId}
          className={itemClassName(sessionId)}
          onClick={() => onItemClick(sessionId)}
          onContextMenu={(e) => onItemContextMenu(e, sessionId)}
          onDragEnd={handleDragEnd}
          style={{ listStyle: 'none' }}
          layout="position"
        >
          {renderContent(sessionId)}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}

// ============================================================
// AgentReorderGroup — 隔离智能体组拖拽排序状态
// 拖拽过程中只更新本地 state，onDragEnd 才提交到全局 store
// ============================================================

function AgentReorderGroup({
  agents,
  renderAgent,
}: {
  agents: Role[];
  renderAgent: (agent: Role) => React.ReactNode;
}) {
  const [localAgents, setLocalAgents] = useState(agents);
  const setAgentsOrder = useSettingsStore((s) => s.setAgentsOrder);

  // 智能体 ID 集合签名（用于检测增删）
  const setSig = useMemo(() => agents.map((a) => a.id).sort().join(','), [agents]);

  useEffect(() => {
    const localSet = new Set(localAgents.map((a) => a.id));
    const externalSet = new Set(agents.map((a) => a.id));
    if (localSet.size !== externalSet.size || [...localSet].some((id) => !externalSet.has(id))) {
      setLocalAgents(agents);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSig]);

  const handleDragEnd = () => {
    setAgentsOrder(localAgents);
  };

  return (
    <Reorder.Group as="div" axis="y" values={localAgents} onReorder={setLocalAgents} className={styles.list}>
      {localAgents.map((agent) => (
        <Reorder.Item
          as="div"
          key={agent.id}
          value={agent}
          onDragEnd={handleDragEnd}
          drag={agent.id !== DEFAULT_AGENT_ID}
          className={styles.agentGroup}
          style={{ listStyle: 'none' }}
          layout="position"
        >
          {renderAgent(agent)}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}

// ============================================================
// SessionItemContent — 会话列表项内容（memo 优化：跳过流式输出中 messageTree 内容变化的无关重渲染）
// ============================================================

type SessionItemContentProps = {
  session: import('../types').Session;
  isActive: boolean;
  isEditing: boolean;
  editTitle: string;
  setEditTitle: (v: string) => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  saveRename: () => void;
  cancelRename: () => void;
  formatTime: (ts: number) => string;
  now: number;
};

const SessionItemContent = memo(function SessionItemContent({
  session,
  isActive,
  isEditing,
  editTitle,
  setEditTitle,
  editInputRef,
  saveRename,
  cancelRename,
  formatTime,
  now,
}: SessionItemContentProps) {
  const isStarred = !!session.isStarred;
  return (
    <>
      <div className={styles.sessionHeader}>
        {isEditing ? (
          <input
            ref={editInputRef}
            type="text"
            className={styles.editInput}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveRename();
              if (e.key === 'Escape') cancelRename();
            }}
            onBlur={saveRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            {isStarred && <span className={styles.starIcon}>★</span>}
            <span className={styles.sessionTitle}>{session.title}</span>
            {session.isStreaming && (
              <span className={styles.streamingSpinner} title="正在接收响应" />
            )}
            {session.isQueued && !session.isStreaming && (
              <span className={styles.queuedIndicator} title="排队等待中" />
            )}
            {session.isAgentRunning && !session.isStreaming && !session.isQueued && (
              <span className={styles.agentRunningIndicator} title="正在执行工具" />
            )}
            {!isActive &&
              !session.isStreaming &&
              !session.isAgentRunning &&
              !session.isQueued &&
              session.hasUnread && (
                <span className={styles.unreadDot} title="有未读的新内容" />
              )}
          </>
        )}
      </div>
      {!isEditing && (
        <div className={styles.sessionMeta}>
          <span>{Object.keys(session.messageTree).length} 条消息</span>
          <span>{formatTime(session.updatedAt)}</span>
        </div>
      )}
    </>
  );
}, function areEqual(prev, next) {
  // 只比较会话列表关心的字段，忽略 messageTree 内部内容变化（流式输出时频繁变化但不影响列表显示）
  return (
    prev.session.id === next.session.id &&
    prev.session.title === next.session.title &&
    prev.session.isStarred === next.session.isStarred &&
    prev.session.isStreaming === next.session.isStreaming &&
    prev.session.isAgentRunning === next.session.isAgentRunning &&
    prev.session.isQueued === next.session.isQueued &&
    prev.session.updatedAt === next.session.updatedAt &&
    prev.session.hasUnread === next.session.hasUnread &&
    Object.keys(prev.session.messageTree).length === Object.keys(next.session.messageTree).length &&
    prev.isActive === next.isActive &&
    prev.isEditing === next.isEditing &&
    prev.editTitle === next.editTitle &&
    prev.now === next.now
  );
});

export default function SessionList() {
  const sessions = useChatStore((state) => state.sessions);
  const sessionOrder = useChatStore((state) => state.sessionOrder);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const createSession = useChatStore((state) => state.createSession);
  const switchSession = useChatStore((state) => state.switchSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const renameSession = useChatStore((state) => state.renameSession);
  const moveSession = useChatStore((state) => state.moveSession);
  const duplicateSession = useChatStore((state) => state.duplicateSession);
  const toggleStarSession = useChatStore((state) => state.toggleStarSession);
  const reorderSessions = useChatStore((state) => state.reorderSessions);

  const roles = useSettingsStore((state) => state.roles);
  const setAgentsOrder = useSettingsStore((state) => state.setAgentsOrder);

  // ── 侧边栏折叠 / 宽度 ────────────────────────────────────
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('sessionListCollapsed') === 'true';
  });
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem('sessionListWidth');
    return stored ? Math.max(160, Math.min(480, parseInt(stored, 10))) : 240;
  });

  // ── 智能体组折叠 ───────────────────────────────────────────
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('agentGroupCollapsed') || '{}');
    } catch { return {}; }
  });

  // ── 重命名状态 ───────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── 删除确认 ─────────────────────────────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── 周期性刷新时间显示（每 30 秒） ────────────────────────
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // ── 右键菜单 ─────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    moveSubmenuFlipped?: boolean;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // ── 侧边栏宽度拖拽 ───────────────────────────────────────
  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sessionListCollapsed', String(next));
  };

  const toggleGroup = (agentId: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [agentId]: !prev[agentId] };
      localStorage.setItem('agentGroupCollapsed', JSON.stringify(next));
      return next;
    });
  };

  const handleResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return;
    if (collapsed) return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(160, Math.min(480, startWidth + ev.clientX - startX));
      setWidth(newWidth);
      localStorage.setItem('sessionListWidth', String(newWidth));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // ── 会话操作 ─────────────────────────────────────────────
  const handleSwitch = (sessionId: string) => {
    if (sessionId !== currentSessionId) switchSession(sessionId);
  };

  const handleDelete = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sessions[sessionId]) return;
    setDeleteConfirmId(sessionId);
  };

  const confirmDelete = () => {
    if (deleteConfirmId) deleteSession(deleteConfirmId);
    setDeleteConfirmId(null);
  };

  const startRename = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const session = sessions[sessionId];
    if (!session) return;
    setEditingId(sessionId);
    setEditTitle(session.title);
  };

  const saveRename = useCallback(() => {
    if (editingId && editTitle.trim()) renameSession(editingId, editTitle.trim());
    setEditingId(null);
    setEditTitle('');
  }, [editingId, editTitle, renameSession]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditTitle('');
  }, []);

  // ── 右键菜单事件 ─────────────────────────────────────────
  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();

    // 估算右键菜单高度（约 240px，含新增的"复制"项），如果下方空间不足则翻转到上方
    const estimatedMenuHeight = 240;
    const y = e.clientY + estimatedMenuHeight > window.innerHeight
      ? e.clientY - estimatedMenuHeight
      : e.clientY;

    // 计算「移动到」子菜单是否需要翻转
    // 子菜单位于主菜单内第 5 个菜单项（前面: 重命名 + 自动命名 + 复制 + 关注 + 分隔线）
    const moveItemOffsetInMenu = 4 /* padding-top */ + 34 * 4 /* 前4项 */ + 9 /* 分隔线 */;
    const targetAgentsCount = orderedAgents.filter((r) => r.id !== sessions[sessionId]?.agentId).length;
    const submenuHeight = targetAgentsCount > 0 ? 8 + targetAgentsCount * 36 : 0;
    const moveSubmenuFlipped = targetAgentsCount > 0 && (y + moveItemOffsetInMenu + submenuHeight) > window.innerHeight;

    setContextMenu({ x: e.clientX, y, sessionId, moveSubmenuFlipped });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleContextRename = (sessionId: string) => {
    const session = sessions[sessionId];
    if (!session) return;
    setEditingId(sessionId);
    setEditTitle(session.title);
    closeContextMenu();
  };

  const handleContextDelete = (sessionId: string) => {
    if (!sessions[sessionId]) return;
    setDeleteConfirmId(sessionId);
    closeContextMenu();
  };

  const handleContextAutoName = (sessionId: string) => {
    closeContextMenu();
    // 异步调用自动命名服务，不阻塞 UI
    autoNameSession(sessionId);
  };

  const handleContextDuplicate = (sessionId: string) => {
    closeContextMenu();
    duplicateSession(sessionId);
  };

  const handleContextToggleStar = (sessionId: string) => {
    closeContextMenu();
    toggleStarSession(sessionId);
  };

  const handleContextMoveTo = (sessionId: string, targetAgentId: string) => {
    closeContextMenu();
    moveSession(sessionId, targetAgentId, null);
  };

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const formatTime = useCallback((timestamp: number) => {
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  }, [now]);

  // ── 分组计算 ─────────────────────────────────────────────
  const orderedAgents = useMemo(() => {
    const defaultAgent = roles.find((r) => r.id === DEFAULT_AGENT_ID);
    const others = roles.filter((r) => r.id !== DEFAULT_AGENT_ID);
    // 按 roles 数组顺序排列（默认智能体固定在首位），支持拖拽调整
    return defaultAgent ? [defaultAgent, ...others] : others;
  }, [roles]);

  const sessionsByAgent = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const sessionId of sessionOrder) {
      const session = sessions[sessionId];
      if (!session) continue;
      const rid = session.agentId;
      if (!map[rid]) map[rid] = [];
      map[rid].push(sessionId);
    }
    // 每个智能体组内：关注会话（置顶）在前，未关注在后，各自保持原始顺序
    for (const rid of Object.keys(map)) {
      const ids = map[rid];
      const starred = ids.filter((id) => sessions[id]?.isStarred);
      const unstarred = ids.filter((id) => !sessions[id]?.isStarred);
      // starred 保持它们在 sessionOrder 中的顺序
      starred.sort((a, b) => sessionOrder.indexOf(a) - sessionOrder.indexOf(b));
      // unstarred 也保持原有顺序
      unstarred.sort((a, b) => sessionOrder.indexOf(a) - sessionOrder.indexOf(b));
      map[rid] = [...starred, ...unstarred];
    }
    return map;
  }, [sessions, sessionOrder]);

  // ── 右键菜单（useMemo 隔离：流式 re-render 时跳过 reconciliation） ──
  const contextMenuElement = useMemo(() => {
    if (!contextMenu) return null;

    const sessionAgentId = sessions[contextMenu.sessionId]?.agentId;
    // 可移动到的目标智能体列表（排除当前所属智能体）
    const targetAgents = orderedAgents.filter((r) => r.id !== sessionAgentId);

    return (
      <>
        {/* 全屏透明遮罩：点击或右键任意位置关闭菜单 */}
        <div
          className={styles.contextMenuBackdrop}
          onClick={closeContextMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeContextMenu();
          }}
        />
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <div
            className={styles.contextMenuItem}
            onClick={() => handleContextRename(contextMenu.sessionId)}
          >
            <span className={styles.contextMenuIcon}>✎</span>
            重命名
          </div>
          <div
            className={styles.contextMenuItem}
            onClick={() => handleContextAutoName(contextMenu.sessionId)}
          >
            <span className={styles.contextMenuIcon}>⟳</span>
            自动命名
          </div>
          <div
            className={styles.contextMenuItem}
            onClick={() => handleContextDuplicate(contextMenu.sessionId)}
          >
            <span className={styles.contextMenuIcon}>⧉</span>
            复制
          </div>
          <div
            className={styles.contextMenuItem}
            onClick={() => handleContextToggleStar(contextMenu.sessionId)}
          >
            <span className={`${styles.contextMenuIcon} ${styles.starMenuIcon}`}>
              {sessions[contextMenu.sessionId]?.isStarred ? '★' : '☆'}
            </span>
            {sessions[contextMenu.sessionId]?.isStarred ? '取消关注' : '关注'}
          </div>
          {/* ── 移动到 ── */}
          {targetAgents.length > 0 && (
            <>
              <div className={styles.contextMenuDivider} />
              <div
                className={`${styles.contextMenuItem} ${styles.contextMenuMoveTo}`}
              >
                <span className={styles.contextMenuIcon}>↗</span>
                移动到
                <span className={styles.contextMenuArrow}>▶</span>
                <div className={`${styles.contextMenuSubmenu} ${contextMenu.moveSubmenuFlipped ? styles.contextMenuSubmenuFlipped : ''}`}>
                  {targetAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className={styles.contextMenuSubmenuItem}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleContextMoveTo(contextMenu.sessionId, agent.id);
                      }}
                    >
                      <span className={styles.contextMenuIcon}>{(agent.name ?? '?').slice(0, 1)}</span>
                      {agent.name ?? '未命名'}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          <div className={styles.contextMenuDivider} />
          <div
            className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`}
            onClick={() => handleContextDelete(contextMenu.sessionId)}
          >
            <span className={styles.contextMenuIcon}>✕</span>
            删除
          </div>
        </div>
      </>
    );
  }, [contextMenu]);

  return (
    <div
      className={`${styles.wrapper} ${collapsed ? styles.wrapperCollapsed : ''}`}
      style={collapsed ? undefined : { width }}
    >
      {!collapsed && (
        <AgentReorderGroup
          agents={orderedAgents}
          renderAgent={(role) => {
            const groupSessions = sessionsByAgent[role.id] ?? [];
            const isGroupCollapsed = !!collapsedGroups[role.id];

            // 分离关注/未关注
            const starredSessions = groupSessions.filter((id) => sessions[id]?.isStarred);
            const unstarredSessions = groupSessions.filter((id) => !sessions[id]?.isStarred);

            return (
              <>
                {/* 智能体组标题行 */}
                <div
                  className={styles.agentGroupHeader}
                  onClick={() => toggleGroup(role.id)}
                >
                  <ChevronIcon
                    className={`${styles.chevron} ${isGroupCollapsed ? styles.chevronCollapsed : ''}`}
                    size={12} strokeWidth={2.5}
                  />
                  <span className={styles.agentGroupName}>{role.name ?? '未命名'}</span>
                  <span className={styles.agentGroupCount}>{groupSessions.length}</span>
                  <button
                    className={styles.groupCreateBtn}
                    title={`在「${role.name ?? '未命名'}」下新建会话`}
                    onClick={(e) => {
                      e.stopPropagation();
                      createSession(role.id);
                    }}
                  >
                    +
                  </button>
                </div>

                {/* 会话列表 — 使用 CSS 过渡折叠，避免 framer-motion layout 动画异常 */}
                <div className={`${styles.groupSessions} ${isGroupCollapsed ? styles.groupSessionsCollapsed : ''}`}>
                  {/* 关注分区 */}
                  <SessionReorderGroup
                    agentId={role.id}
                    sessionIds={starredSessions}
                    isStarred={true}
                    itemClassName={(sessionId) =>
                      [
                        styles.sessionItem,
                        sessionId === currentSessionId ? styles.active : '',
                        styles.starred,
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }
                    renderContent={(sessionId) => {
                      const session = sessions[sessionId];
                      if (!session) return null;
                      return (
                        <SessionItemContent
                          session={session}
                          isActive={sessionId === currentSessionId}
                          isEditing={editingId === sessionId}
                          editTitle={editTitle}
                          setEditTitle={setEditTitle}
                          editInputRef={editInputRef}
                          saveRename={saveRename}
                          cancelRename={cancelRename}
                          formatTime={formatTime}
                          now={now}
                        />
                      );
                    }}
                    onItemClick={(sessionId) => handleSwitch(sessionId)}
                    onItemContextMenu={(e, sessionId) => handleContextMenu(e, sessionId)}
                  />

                  {/* 未关注分区 */}
                  <SessionReorderGroup
                    agentId={role.id}
                    sessionIds={unstarredSessions}
                    isStarred={false}
                    itemClassName={(sessionId) =>
                      [
                        styles.sessionItem,
                        sessionId === currentSessionId ? styles.active : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }
                    renderContent={(sessionId) => {
                      const session = sessions[sessionId];
                      if (!session) return null;
                      return (
                        <SessionItemContent
                          session={session}
                          isActive={sessionId === currentSessionId}
                          isEditing={editingId === sessionId}
                          editTitle={editTitle}
                          setEditTitle={setEditTitle}
                          editInputRef={editInputRef}
                          saveRename={saveRename}
                          cancelRename={cancelRename}
                          formatTime={formatTime}
                          now={now}
                        />
                      );
                    }}
                    onItemClick={(sessionId) => handleSwitch(sessionId)}
                    onItemContextMenu={(e, sessionId) => handleContextMenu(e, sessionId)}
                  />
                </div>
              </>
            );
          }}
        />
      )}

      {contextMenuElement}

      {/* 删除确认对话框 */}
      <Modal
        open={!!deleteConfirmId && !!sessions[deleteConfirmId]}
        onClose={() => setDeleteConfirmId(null)}
        title="删除会话"
        maxWidth="300px"
        footer={
          <>
            <button className={styles.modalCancel} onClick={() => setDeleteConfirmId(null)}>取消</button>
            <button className={styles.modalConfirm} onClick={confirmDelete}>删除</button>
          </>
        }
      >
        {deleteConfirmId && sessions[deleteConfirmId] && (
          <p className={styles.modalBody}>
            确定删除会话「<span className={styles.modalSessionName}>{sessions[deleteConfirmId].title}</span>」吗？此操作不可撤销。
          </p>
        )}
      </Modal>

      {/* 右侧边界：拖拽调宽 + 折叠柄 */}
      <div className={styles.sideHandle} onMouseDown={handleResizeMouseDown}>
        <div
          className={styles.collapseHoverZone}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button
          className={styles.collapseToggle}
          onClick={toggleCollapse}
          onMouseDown={(e) => e.stopPropagation()}
          title={collapsed ? '展开会话列表' : '收起会话列表'}
        >
          <ChevronIcon direction={collapsed ? 'right' : 'left'} size={10} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
