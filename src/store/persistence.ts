// ============================================================
// 聊天记录持久化模块
// 负责 load / save 的核心实现，从 chatStore.ts 中提取以降低其复杂度。
//
// 持久化策略：
//   Electron → IPC → sessions/ + chat-index.json（v4 拆分格式）
//   浏览器  → localStorage key: 'chat-history'
//   热备份  → sessionStorage key: 'chat-history-session'（应对 HMR）
//
// 增量保存策略：
//   - 脏标记（dirtySessions）：仅序列化已变更的会话，其余复用磁盘缓存
//   - 统一调度器（scheduleSave）：1 秒防抖 + 2 秒最小间隔，合并高频操作
// ============================================================

import type { Message, Session } from '../types';
import { DEFAULT_AGENT_ID } from '../types';
import { createEmptySession } from '../utils/sessionHelpers';
import { ensureSystemRootNode } from '../utils/treeUtils';
import { useSettingsStore } from './settingsStore';

// ── 模块级状态 ─────────────────────────────────────────────

/** 保存并发控制：防止多次 saveChatHistory 并发执行导致旧状态覆盖新状态 */
let isSaving = false;
let pendingSave = false;

// ── 增量持久化状态 ─────────────────────────────────────────
/** 自上次保存后 messageTree 发生过变更的 session ID */
const dirtySessions = new Set<string>();
/** 已从 store 中删除的 session ID（通知 main.js 清理对应文件） */
const deletedSessions = new Set<string>();
/** 上次成功保存的时间戳（ms） */
let lastSaveTime = 0;
/** 统一调度定时器 */
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

/** 最小保存间隔：2 秒内不重复写盘 */
const MIN_SAVE_INTERVAL = 2000;
/** 默认防抖延迟：变更后等待 1 秒，期间新变更重置计时器 */
const DEFAULT_DEBOUNCE = 1000;

/** Zustand get 引用（由 chatStore 在 create 时注册） */
let storeGetter: (() => any) | null = null;

// ── 加载 ───────────────────────────────────────────────────

/**
 * 加载聊天记录的核心逻辑。
 * @param get Zustand 的 get 函数
 * @param set Zustand 的 set 函数
 */
export async function loadChatHistoryImpl(
  get: () => any,
  set: (partial: any) => void,
): Promise<void> {
  let data: any;

  // ═══ sessionStorage 热备份恢复（应对 Vite HMR 全量刷新导致的内存状态丢失）═══
  try {
    const sessionData = sessionStorage.getItem('chat-history-session');
    if (sessionData) {
      const parsed = JSON.parse(sessionData);
      if (parsed && parsed.sessions) {
        console.log('[chatStore] 从 sessionStorage 恢复对话记录');
        data = parsed;
        // 立即清除：防止 Vite HMR（非全量刷新）重挂载 DataLoader 时
        // 重复消费过期快照，覆盖当前 Zustand 内存状态导致对话"丢失"
        sessionStorage.removeItem('chat-history-session');
      }
    }
  } catch (e) {
    console.warn('[chatStore] sessionStorage 恢复失败，回退到磁盘加载:', e);
  }

  if (!data) {
    if (window.electronAPI) {
      data = await window.electronAPI.readChatHistory();
    } else {
      const stored = localStorage.getItem('chat-history');
      if (stored) {
        try {
          data = JSON.parse(stored);
          if (data.state) {
            data = data.state;
          }
        } catch (error) {
          console.error('Failed to parse chat history:', error);
          localStorage.removeItem('chat-history');
          data = null;
        }
      }
    }
  }

  // 数据迁移：旧格式 { messages: [] } → v3 messageTree
  if (data && data.messages && Array.isArray(data.messages)) {
    const { llmConfig: globalLLM, mcpConfig: globalMCP } = useSettingsStore.getState();
    const legacySession = createEmptySession(DEFAULT_AGENT_ID, { ...globalLLM }, { ...globalMCP });
    legacySession.title = '历史对话';
    let prevId: string | null = null;
    for (const m of data.messages) {
      const msg: Message = { ...m, parentId: prevId };
      legacySession.messageTree[msg.id] = msg;
      prevId = msg.id;
    }
    legacySession.rootMessageId = data.messages[0]?.id ?? null;
    legacySession.execLeafId = data.messages.at(-1)?.id ?? null;
    legacySession.viewLeafId = data.messages.at(-1)?.id ?? null;
    legacySession.createdAt = data.messages[0]?.timestamp || Date.now();
    legacySession.updatedAt =
      data.messages[data.messages.length - 1]?.timestamp || Date.now();

    // ── 迁移：补充 system 根节点 ──
    const { messageTree: migratedTree, rootMessageId: migratedRoot } = ensureSystemRootNode(
      legacySession.messageTree,
      '',
    );
    legacySession.messageTree = migratedTree;
    legacySession.rootMessageId = migratedRoot;

    set({
      sessions: { [legacySession.id]: legacySession },
      sessionOrder: [legacySession.id],
      currentSessionId: legacySession.id,
      isLoaded: true,
    });
    // 迁移完成后标记脏并保存：确保旧格式数据被写入 v4 拆分格式
    markSessionDirty(legacySession.id);
    // 立即保存（不经过防抖，因为这是首次加载，不存在高频操作）
    scheduleSaveInternal(0);
    return;
  }

  // 新格式：{ sessions, sessionOrder, currentSessionId }
  if (data && data.sessions) {
    const sessions: Record<string, Session> = {};
    for (const [id, session] of Object.entries(data.sessions) as [string, any][]) {
      let messageTree = session.messageTree;
      let rootMessageId = session.rootMessageId;
      let rawLeafId = session.execLeafId ?? session.viewLeafId;
      if (session.messages && Array.isArray(session.messages) && !messageTree) {
        messageTree = {};
        let prevId: string | null = null;
        for (const m of session.messages) {
          const msg: Message = { ...m, parentId: prevId };
          messageTree[msg.id] = msg;
          prevId = msg.id;
        }
        rootMessageId = session.messages[0]?.id ?? null;
        rawLeafId = session.messages.at(-1)?.id ?? null;
      }

      const leafId = (rawLeafId && (messageTree || {})[rawLeafId]) ? rawLeafId : (rootMessageId ?? null);

      sessions[id] = {
        ...session,
        messageTree: messageTree || {},
        rootMessageId: rootMessageId ?? null,
        execLeafId: leafId,
        viewLeafId: leafId,
        agentId: (session.agentId ?? session.roleId as string | null | undefined) ?? DEFAULT_AGENT_ID,
        isStreaming: false,
        isAgentRunning: false,
        isRateLimited: false,
        abortController: null,
        currentTool: null,
        draft: (session as any).draft || undefined,
        activeStreams: new Map(),  // 运行时状态，不持久化
      };

      // ── 迁移：为老会话补充 system 根节点 ──
      const effectiveAgentId = (session.agentId ?? session.roleId as string | null | undefined) ?? DEFAULT_AGENT_ID;
      const role = useSettingsStore.getState().roles.find(r => r.id === effectiveAgentId);
      const systemPrompt = role?.systemPrompt?.trim() || '';
      const { messageTree: migratedTree, rootMessageId: migratedRoot } = ensureSystemRootNode(
        sessions[id].messageTree,
        systemPrompt,
      );
      sessions[id] = {
        ...sessions[id],
        messageTree: migratedTree,
        rootMessageId: migratedRoot,
      };

      // ── 迁移：为老会话补全 llmConfig 和 mcpConfig（从智能体/全局快照）──
      if (!sessions[id].llmConfig || !sessions[id].mcpConfig) {
        const { roles, llmConfig: globalLLM, mcpConfig: globalMCP } = useSettingsStore.getState();
        const agent = roles.find(r => r.id === sessions[id].agentId);
        if (!sessions[id].llmConfig) {
          sessions[id] = { ...sessions[id], llmConfig: { ...(agent?.llmConfig ?? globalLLM) } };
        }
        if (!sessions[id].mcpConfig) {
          sessions[id] = { ...sessions[id], mcpConfig: { ...(agent?.mcpConfig ?? globalMCP) } };
        }
      }
    }

    const sessionOrder: string[] = data.sessionOrder || [];
    const rawCurrentId: string | null = data.currentSessionId || null;
    const currentSessionId =
      rawCurrentId && sessions[rawCurrentId] ? rawCurrentId : (sessionOrder[0] ?? null);

    set({
      sessions,
      sessionOrder,
      currentSessionId,
      isLoaded: true,
    });
  } else {
    const { llmConfig: globalLLM, mcpConfig: globalMCP } = useSettingsStore.getState();
    const defaultSession = createEmptySession(DEFAULT_AGENT_ID, { ...globalLLM }, { ...globalMCP });
    set({
      sessions: { [defaultSession.id]: defaultSession },
      sessionOrder: [defaultSession.id],
      currentSessionId: defaultSession.id,
      isLoaded: true,
    });
  }

  // ── 恢复草稿：从 chat-draft-session 合并可能更新的 draft 字段 ──
  // updateSessionDraft 将草稿变更写入 chat-draft-session（不触发持久化），
  // 此处读取并合并到已加载的会话中，防止 HMR 刷新丢草稿。
  try {
    const draftData = sessionStorage.getItem('chat-draft-session');
    if (draftData) {
      const parsed = JSON.parse(draftData);
      if (parsed && parsed.sessions) {
        set((prev: any) => {
          const updatedSessions = { ...prev.sessions };
          let changed = false;
          for (const [sid, s] of Object.entries(parsed.sessions) as [string, any][]) {
            if (updatedSessions[sid] && s.draft && updatedSessions[sid].draft !== s.draft) {
              updatedSessions[sid] = { ...updatedSessions[sid], draft: s.draft };
              changed = true;
            }
          }
          return changed ? { sessions: updatedSessions } : {};
        });
      }
    }
  } catch {
    // sessionStorage 不可用或数据损坏，静默忽略
  }
}

// ── 公开 API ────────────────────────────────────────────────

/**
 * 标记会话内容已变更，1 秒防抖后保存。
 * 用于：发消息、编辑、星标、删除消息、清空会话、删除会话等所有日常操作。
 */
export function markSessionDirty(sessionId: string) {
  dirtySessions.add(sessionId);
  scheduleSaveInternal(DEFAULT_DEBOUNCE);
}

/**
 * 仅索引变更（如拖拽排序），1 秒防抖后保存。
 * 不标记任何会话为脏，保存时只更新 sessionOrder。
 */
export function scheduleSave() {
  scheduleSaveInternal(DEFAULT_DEBOUNCE);
}

/**
 * 注册 Zustand get 引用。chatStore 在 create 时调用一次。
 */
export function registerSaveGetter(get: () => any) {
  storeGetter = get;
}

// ── 内部调度器 ──────────────────────────────────────────────

function scheduleSaveInternal(delay: number) {
  if (scheduleTimer) clearTimeout(scheduleTimer);

  const elapsed = Date.now() - lastSaveTime;
  const effectiveDelay = Math.max(delay, MIN_SAVE_INTERVAL - elapsed);

  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    if (storeGetter) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      saveChatHistoryImpl(storeGetter);
    }
  }, effectiveDelay);
}

// ── 会话清洗工具 ────────────────────────────────────────────

function cleanSession(session: Session): Record<string, any> {
  return {
    id: session.id,
    title: session.title,
    isStarred: !!session.isStarred,
    thinkingMode: session.thinkingMode || 'auto',
    draft: session.draft || '',
    rootMessageId: session.rootMessageId,
    execLeafId: session.execLeafId,
    viewLeafId: session.viewLeafId,
    messageTree: Object.fromEntries(
      Object.entries(session.messageTree)
        .map(([msgId, m]) => [msgId, {
          id: m.id,
          parentId: m.parentId,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          ...(m.tokenUsage ? { tokenUsage: m.tokenUsage } : {}),
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolResult ? { toolResult: m.toolResult } : {}),
          ...(m.model ? { model: m.model } : {}),
          ...(m.providerName ? { providerName: m.providerName } : {}),
        }]),
    ),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentId: session.agentId,
    llmConfig: session.llmConfig,
    mcpConfig: session.mcpConfig,
  };
}

// ── 保存（增量版） ──────────────────────────────────────────

/**
 * 保存聊天记录的核心逻辑。
 * 仅序列化 dirtySessions 中的会话，其余会话复用磁盘已有数据。
 * sessionOrder 和 currentSessionId 始终写入索引。
 */
export async function saveChatHistoryImpl(get: () => any): Promise<void> {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;

  try {
    const { sessions, sessionOrder, currentSessionId } = get();

    // ── 处理已删除的会话 ──
    const deletedIds: string[] = [];
    for (const sid of dirtySessions) {
      if (!sessions[sid]) {
        deletedIds.push(sid);
      }
    }
    // 从 dirtySessions 中移除已删除的（在 deletedSessions 中处理）
    for (const sid of deletedIds) {
      dirtySessions.delete(sid);
      deletedSessions.add(sid);
    }

    // ── 只序列化脏会话 ──
    const dirtyData: Record<string, any> = {};
    for (const sid of dirtySessions) {
      const session = sessions[sid];
      if (session) {
        dirtyData[sid] = cleanSession(session);
      }
    }

    // ── IPC: 发送增量数据 ──
    if (window.electronAPI) {
      await window.electronAPI.writeChatHistory({
        type: 'partial',
        sessions: dirtyData,
        sessionOrder,
        currentSessionId,
        deletedIds: [...deletedSessions],
      });
    } else {
      // 浏览器环境：读取 localStorage → 合并 → 写回
      try {
        const stored = JSON.parse(localStorage.getItem('chat-history') || '{}');
        const merged = { ...(stored.state?.sessions || {}), ...dirtyData };
        for (const sid of deletedSessions) delete merged[sid];
        localStorage.setItem('chat-history', JSON.stringify({
          state: { version: 3, sessions: merged, sessionOrder, currentSessionId },
        }));
      } catch { /* localStorage 满或损坏，忽略 */ }
    }

    // ── 清理脏标记 ──
    dirtySessions.clear();
    deletedSessions.clear();
    lastSaveTime = Date.now();

  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      await saveChatHistoryImpl(get);
    }
  }
}

/**
 * 重置保存并发控制状态（cleanup 时调用）
 */
export function resetSavingState(): void {
  isSaving = false;
  pendingSave = false;
  // 清理调度器（防止应用关闭后定时器仍触发）
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}
