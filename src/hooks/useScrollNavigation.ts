// ============================================================
// useScrollNavigation — 聊天消息列表滚动导航逻辑
//
// 封装：
//   - 自动跟随滚动（autoScroll）
//   - user 消息前后导航（prev/next）
//   - 流式输出时自动滚到底部
//   - 会话切换 / 总览视图 / 页面切换时保存恢复滚动位置
// ============================================================

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { Message } from '../types';
import { clearScrollCache, clearAllScrollCache, savedScrollTops } from '../utils/scrollCache';

// 重新导出以保持向后兼容
export { clearScrollCache, clearAllScrollCache };

interface UseScrollNavigationOptions {
  /** 当前活跃路径消息列表 */
  messages: Message[];
  /** 是否流式输出中 */
  isStreaming: boolean;
  /** 是否 Agent 运行中 */
  isAgentRunning: boolean;
  /** 当前会话 ID（用于重置自动滚动） */
  currentSessionId: string | null;
  /** 当前视图分支叶子 ID（分支切换时保存/恢复各分支的滚动位置） */
  viewLeafId?: string | null;
  /** 是否正在显示树总览视图（消息列表未渲染，跳过自动保存恢复） */
  isTreeVisible?: boolean;
}

interface UseScrollNavigationReturn {
  /** 滚动容器 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 底部锚点 ref */
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  /** 是否自动跟随滚动 */
  autoScroll: boolean;
  /** 是否处于锁定滚动状态（跟随滚动激活中，应隐藏滚动条并阻止用户滚动） */
  autoScrollLocked: boolean;
  /** 回到顶部 */
  scrollToTop: () => void;
  /** 到上一条 user */
  scrollToPrevUser: () => void;
  /** 到下一条 user */
  scrollToNextUser: () => void;
  /** 切换自动滚动 */
  toggleAutoScroll: () => void;
  /** 滚到底部 */
  scrollToBottom: () => void;
  /** 手动保存当前滚动位置（进入总览视图前调用） */
  saveScrollPosition: () => void;
  /** 手动恢复滚动位置（退出总览视图且非导航时调用） */
  restoreScrollPosition: () => void;
}

export function useScrollNavigation({
  messages,
  isStreaming,
  isAgentRunning,
  currentSessionId,
  viewLeafId,
  isTreeVisible,
}: UseScrollNavigationOptions): UseScrollNavigationReturn {
  const [autoScroll, setAutoScroll] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 记录上一个会话 ID，用于在切换前保存滚动位置
  const prevSessionIdRef = useRef<string | null>(null);

  // 应用启动后是否已完成首次滚底（确保打开程序时第一个会话一定滚到底）
  const initialScrollDoneRef = useRef(false);

  // ── 会话切换 — 保存/恢复滚动位置 ──
  // 使用 useLayoutEffect 在 paint 前同步设置滚动位置，消除闪烁，且不占用 rAF 队列
  useLayoutEffect(() => {
    // 🐛 修复：树总览可见时（容器 overflow:hidden）不保存/恢复滚动位置
    if (isTreeVisible) {
      prevSessionIdRef.current = currentSessionId;
      return;
    }

    // 🐛 修复：仅 isTreeVisible 变化（关闭树）但会话未切换时，跳过保存/恢复
    if (prevSessionIdRef.current === currentSessionId) {
      // 🐛 修复：若该会话是在树总览可见期间创建的（savedScrollTops 无记录），
      // 关闭树时补上"首次访问滚到底部"逻辑，防止停在顶部
      if (currentSessionId && !initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      } else if (currentSessionId && !savedScrollTops.has(currentSessionId)) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }
      return;
    }

    // 保存上一个会话的滚动位置
    if (prevSessionIdRef.current && containerRef.current) {
      savedScrollTops.set(prevSessionIdRef.current, containerRef.current.scrollTop);
    }
    prevSessionIdRef.current = currentSessionId;

    if (!currentSessionId) return;

    setAutoScroll(true);
    if (!initialScrollDoneRef.current) {
      // 应用启动后第一次：无论哪个会话，直接滚到底
      initialScrollDoneRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    } else if (isStreaming || isAgentRunning) {
      // 目标会话正在流式输出 → 始终滚到底部，不恢复旧位置
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    } else if (savedScrollTops.has(currentSessionId)) {
      // 非首次访问：恢复到上次离开时的位置
      const savedTop = savedScrollTops.get(currentSessionId);
      if (savedTop !== undefined && containerRef.current) {
        containerRef.current.scrollTop = savedTop;
      }
    } else {
      // 首次访问该会话（非首次滚底）：滚到底部
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [currentSessionId, isTreeVisible]);

  // ── 分支切换 — 保存/恢复各分支的滚动位置 ──
  const prevActiveLeafRef = useRef<string | null>(null);
  const prevIsTreeVisibleRef = useRef(isTreeVisible);
  // 使用 useLayoutEffect 在 paint 前同步设置滚动位置，消除闪烁，且不占用 rAF 队列
  useLayoutEffect(() => {
    const wasInTree = prevIsTreeVisibleRef.current;
    prevIsTreeVisibleRef.current = isTreeVisible;

    if (!currentSessionId || !viewLeafId) return;
    if (viewLeafId === prevActiveLeafRef.current) return;
    if (isStreaming || isAgentRunning) return;

    // 🐛 修复：树总览可见时（容器 overflow:hidden）不保存/恢复滚动位置
    if (isTreeVisible) {
      prevActiveLeafRef.current = viewLeafId;
      return;
    }

    // 🐛 修复：刚从树总览退出时，由 onNavigate / switchToMessageAndCloseTree
    // 负责滚动目标位置，跳过 effect 避免竞争覆盖
    if (wasInTree) {
      prevActiveLeafRef.current = viewLeafId;
      return;
    }

    // 保存上一分支的滚动位置
    if (prevActiveLeafRef.current && containerRef.current) {
      const branchKey = `${currentSessionId}::branch::${prevActiveLeafRef.current}`;
      savedScrollTops.set(branchKey, containerRef.current.scrollTop);
    }
    prevActiveLeafRef.current = viewLeafId;

    // 恢复当前分支的滚动位置，或首次访问该分支则滚到底部
    const branchKey = `${currentSessionId}::branch::${viewLeafId}`;
    const savedTop = savedScrollTops.get(branchKey);
    if (savedTop !== undefined && containerRef.current) {
      containerRef.current.scrollTop = savedTop;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [currentSessionId, viewLeafId, isStreaming, isAgentRunning, isTreeVisible]);

  // ── 辅助：将元素滚动到靠上位置 ──
  const scrollToUpperMid = (el: HTMLElement) => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const elTop = rect.top - containerRect.top + container.scrollTop;
    const targetScroll = elTop - container.clientHeight * 0.15;
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'instant' });
  };

  // ── 收集 user 消息 DOM 元素及位置 ──
  const buildUserEntries = () => {
    const container = containerRef.current;
    if (!container) return [];
    const entries: { el: HTMLElement; top: number; index: number }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const el = document.getElementById(`msg-${msg.id}`);
      if (!el) continue;
      const containerRect = container.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const top = rect.top - containerRect.top + container.scrollTop;
      entries.push({ el, top, index: i });
    }
    return entries;
  };

  // ── 上一条 user ──
  const scrollToPrevUser = () => {
    const container = containerRef.current;
    if (!container || messages.length === 0) return;

    const userEntries = buildUserEntries();
    if (userEntries.length === 0) return;

    const scrollTargetLine = container.scrollTop + container.clientHeight * 0.15;
    let targetIdx = -1;
    let minDist = Infinity;
    for (let i = 0; i < userEntries.length; i++) {
      if (userEntries[i].top >= scrollTargetLine - 3) continue;
      const dist = scrollTargetLine - userEntries[i].top;
      if (dist < minDist) { minDist = dist; targetIdx = i; }
    }

    if (targetIdx >= 0) {
      scrollToUpperMid(userEntries[targetIdx].el);
    } else {
      container.scrollTo({ top: 0, behavior: 'instant' });
    }
  };

  // ── 下一条 user ──
  const scrollToNextUser = () => {
    const container = containerRef.current;
    if (!container || messages.length === 0) return;

    const userEntries = buildUserEntries();
    if (userEntries.length === 0) return;

    const scrollTargetLine = container.scrollTop + container.clientHeight * 0.15;
    let targetIdx = -1;
    let minDist = Infinity;
    for (let i = 0; i < userEntries.length; i++) {
      if (userEntries[i].top <= scrollTargetLine + 3) continue;
      const dist = userEntries[i].top - scrollTargetLine;
      if (dist < minDist) { minDist = dist; targetIdx = i; }
    }

    if (targetIdx >= 0) {
      scrollToUpperMid(userEntries[targetIdx].el);
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  };

  // ── 回到顶部 ──
  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  };

  // ── 滚到底部 ──
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  };

  // ── 切换自动滚动 ──
  const toggleAutoScroll = () => setAutoScroll((v) => !v);

  // 是否处于锁定滚动状态：跟随滚动激活时，禁止用户手动滚动
  const autoScrollLocked = autoScroll && (isStreaming || isAgentRunning);

  // ── 跟随滚动开启时立即滚到底部（解决点击按钮后无新消息时无法立刻滚底的延迟问题） ──
  useLayoutEffect(() => {
    if (autoScrollLocked) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [autoScrollLocked]);

  // ── 跟随滚动锁定：阻止用户滚轮/键盘/触控板滚动（解决用户向上滚动被拖回底部的"对抗"问题） ──
  // 🐛 修复：使用 capture: true 在捕获阶段拦截事件，
  //   确保子滚动条（思考链 data-auto-scroll="reasoning"、工具参数 data-auto-scroll="tool-args"）
  //   也能被阻止，与主容器享受同等的防对抗保护。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (autoScrollLocked) {
      const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
      };
      // 🐛 修复：同时拦截键盘滚动（PageUp/PageDown/Home/End/ArrowUp/ArrowDown/Space），
      //    防止用户通过键盘脱离锁定状态后，被下一帧 chunk 拖回底部。
      const handleKeyDown = (e: KeyboardEvent) => {
        const scrollKeys = [
          'PageUp', 'PageDown', 'Home', 'End',
          'ArrowUp', 'ArrowDown', ' ',
        ];
        if (scrollKeys.includes(e.key)) {
          e.preventDefault();
        }
      };
      // capture: true — 捕获阶段拦截，在事件到达子元素（包括 data-auto-scroll 子滚动条）之前就阻止
      container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
      container.addEventListener('keydown', handleKeyDown, { capture: true });
      return () => {
        container.removeEventListener('wheel', handleWheel, { capture: true });
        container.removeEventListener('keydown', handleKeyDown, { capture: true });
      };
    }
  }, [autoScrollLocked]);

  // ── 手动保存/恢复滚动位置（供总览视图进出使用） ──
  const saveScrollPosition = useCallback(() => {
    if (currentSessionId && containerRef.current) {
      savedScrollTops.set(currentSessionId, containerRef.current.scrollTop);
    }
  }, [currentSessionId]);

  const restoreScrollPosition = useCallback(() => {
    if (!currentSessionId || !containerRef.current) return;
    const savedTop = savedScrollTops.get(currentSessionId);
    if (savedTop !== undefined) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = savedTop;
        }
      });
    }
  }, [currentSessionId]);

  // ── 流式输出时自动滚到底部 ──
  // 🐛 修复：使用 messages.length + 最后一条消息 id + 最后一条消息内容长度作为依赖，
  //   而非整个 messages 数组引用。messages 数组每次渲染都由 getActivePath() 重新创建
  //   （新引用），导致 effect 在无关状态变化时也触发。改用标量依赖确保仅在消息列表结构
  //   或最后一条消息内容真正变化时才执行。
  // 🐛 修复（子滚动条）：额外跟踪 reasoning 和 toolCalls 参数的变化，
  //   确保思考链流式输出和工具调用参数展开时，子滚动条也能跟随到底部。
  const lastMsg = messages.at(-1);
  const lastMsgId = lastMsg?.id ?? null;
  const msgCount = messages.length;
  const lastMsgContentLen = lastMsg?.content.length ?? 0;
  const lastMsgReasoningLen = lastMsg?.reasoning?.length ?? 0;
  const lastMsgToolCallsArgsLen = lastMsg?.toolCalls?.reduce(
    (sum, tc) => sum + (tc.arguments?.length ?? 0),
    0,
  ) ?? 0;
  useLayoutEffect(() => {
    if ((isStreaming || isAgentRunning) && autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      // 将最后一条消息内所有 data-auto-scroll 元素滚到底部
      const curLastMsg = messages.at(-1);
      if (curLastMsg) {
        const lastMsgEl = document.getElementById(`msg-${curLastMsg.id}`);
        if (lastMsgEl) {
          lastMsgEl.querySelectorAll('[data-auto-scroll]').forEach((el) => {
            el.scrollTop = el.scrollHeight;
          });
        }
      }
    }
  }, [msgCount, lastMsgId, lastMsgContentLen, lastMsgReasoningLen, lastMsgToolCallsArgsLen, isStreaming, isAgentRunning, autoScroll]);

  return {
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
  };
}
