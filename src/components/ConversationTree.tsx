// ============================================================
// ConversationTree — 对话总览树（画布模式）
//   - 节点用 SVG 连线，卡片式不占满宽度
//   - 鼠标拖拽平移 + 滚轮缩放
//   - 支持多分支总览：活跃分支高亮，非活跃分支淡化
// ============================================================

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import type { Message } from '../types';
import { EditIcon, CopyIcon, RetryIcon, ContinueIcon, DeleteIcon } from './icons';
import { useChatStore } from '../store/chatStore';
import { getDirectBranchLeaves } from '../utils/treeUtils';
import styles from './ConversationTree.module.css';

// ── 类型 ──────────────────────────────────────────────────

interface TreeNode {
  id: string;
  type: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result' | 'streaming';
  messageId?: string;
  label: string;
  sublabel?: string;
  children: TreeNode[];
  roundIndex?: number;
  roundPosition?: 'start' | 'middle' | 'end' | 'standalone';
  /** 助理节点的阶段：thinking=思考中, tool-calling=调用工具, answering=最终回答 */
  assistantPhase?: 'thinking' | 'tool-calling' | 'answering';
  /** 紧凑模式：折叠后的摘要条，高度为 TOOL_NODE_H */
  compact?: boolean;
  isCurrent: boolean;
  isStreaming: boolean;
  /** 是否在执行路径上（流式正在写入的分支） */
  isExecuting: boolean;
  /** 是否属于非活跃分支（opacity:0.4） */
  isInactive: boolean;
  isError?: boolean;
}

interface LayoutNode {
  id: string;
  treeNode: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
}

interface TreeEdge {
  fromId: string;
  toId: string;
  x1: number; y1: number;
  x2: number; y2: number;
  /** 该边是否属于分支分叉（同一父节点有多个子节点时标记） */
  isBranch?: boolean;
}

interface RoundGroup {
  roundIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  position: 'start' | 'middle' | 'end' | 'standalone';
}

// 布局常量 — 多叉树布局（自上而下，兄弟节点水平并排）
const NODE_W = 220;
const GC_W = 180;
const NODE_H = 42;        // 普通节点高度
const TOOL_NODE_H = 26;   // 工具节点高度
const H_GAP = 32;         // 兄弟节点水平间距
/** 父子层级垂直间距（紧凑模式，链式对话减少竹竿效应） */
const V_GAP = 28;
/** 同一 MCP 轮次内相邻助理节点的垂直间距（极紧凑，蓝框已提供视觉分组） */
const ROUND_V_GAP = 4;
const CHILD_GAP = 2;      // 工具子节点间距
const PAD_TOP = 24;       // 画布顶部内边距
const PAD_SIDE = 24;      // 画布左右内边距

// 工具水平网格布局常量
const TOOL_COMPACT_W = 152; // 工具节点在网格中的宽度
const TOOL_GAP_X = 6;       // 工具节点水平间距
/** 每行最多可容纳的工具数（基于 NODE_W 计算） */
function toolsPerRow(): number {
  return Math.max(1, Math.floor(NODE_W / (TOOL_COMPACT_W + TOOL_GAP_X)));
}

// ── roundMap：树结构 MCP 轮次计算 ────────────────────

/**
 * 基于消息树的拓扑结构计算每个 assistant 消息的 MCP 轮次归属。
 *
 * 核心规则（不依赖收集顺序，纯树结构驱动）：
 *   ① enters = hasToolCalls || parentIsTool  → 进入/延续轮次
 *   ② newChain = hasToolCalls && parentIsAssistant && inRound → 从 assistant
 *      分叉出的独立 tool 链，强制开启新轮次
 *   ③ user 消息的每个子节点获得独立的 MCP 状态空间（不同分支 = 不同 MCP 组）
 *   ④ enters=false 的 assistant 切断轮次，不向子节点传递 inRound
 *   ⑤ roundPosition 按 DFS 出现顺序后处理分配（start / middle / end / standalone）
 */
function computeRoundMap(
  messageTree: Record<string, Message>,
  rootMessageId: string | null,
): Map<string, { roundIndex: number; roundPosition: 'start' | 'middle' | 'end' | 'standalone' }> {
  const roundMap = new Map<string, { roundIndex: number; roundPosition: 'start' | 'middle' | 'end' | 'standalone' }>();
  const roundOrder: { roundIndex: number; messageId: string }[] = [];
  let roundIndex = 0;

  function dfs(msgId: string, inRound: boolean): void {
    const msg = messageTree[msgId];
    if (!msg) return;

    const children = Object.values(messageTree)
      .filter(m => m.parentId === msgId)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (msg.role === 'user') {
      // user 消息：子节点各自独立状态
      for (const child of children) {
        dfs(child.id, false);
      }
      return;
    }

    if (msg.role === 'assistant') {
      const hasTC = !!(msg.toolCalls?.length);
      const parent = msg.parentId ? messageTree[msg.parentId] : undefined;
      const parentIsTool = parent?.role === 'tool';
      const parentIsAssistant = parent?.role === 'assistant';
      const enters = hasTC || parentIsTool;
      // 从 assistant 直接分叉出的新 tool 链 → 强制新轮次
      const newChain = hasTC && parentIsAssistant && inRound;

      if (newChain) {
        roundIndex++;
        roundMap.set(msg.id, { roundIndex, roundPosition: 'standalone' });
        roundOrder.push({ roundIndex, messageId: msg.id });
        for (const child of children) dfs(child.id, true);
        return;
      }

      if (enters) {
        if (!inRound) {
          inRound = true;
          roundIndex++;
        }
        roundMap.set(msg.id, { roundIndex, roundPosition: 'standalone' }); // 临时站位，后处理修正
        roundOrder.push({ roundIndex, messageId: msg.id });
        for (const child of children) dfs(child.id, true);
      } else {
        // 不在轮次中：子节点也不继承
        for (const child of children) dfs(child.id, false);
      }
      return;
    }

    // tool / system / streaming 等：透传 inRound
    for (const child of children) dfs(child.id, inRound);
  }

  if (rootMessageId && messageTree[rootMessageId]) {
    dfs(rootMessageId, false);
  }

  // ── 后处理 roundPosition：按 DFS 出现顺序 ──
  const roundGroups = new Map<number, string[]>();
  for (const { roundIndex: ri, messageId: mid } of roundOrder) {
    if (!roundGroups.has(ri)) roundGroups.set(ri, []);
    roundGroups.get(ri)!.push(mid);
  }

  for (const [ri, mids] of roundGroups) {
    if (mids.length === 1) {
      roundMap.get(mids[0])!.roundPosition = 'standalone';
    } else {
      roundMap.get(mids[0])!.roundPosition = 'start';
      for (let i = 1; i < mids.length - 1; i++) {
        roundMap.get(mids[i])!.roundPosition = 'middle';
      }
      roundMap.get(mids[mids.length - 1])!.roundPosition = 'end';
    }
  }

  return roundMap;
}

// ── buildTree ───────────────────────────────────────────

function trunc(s: string, n: number) { const c = s.replace(/\s+/g, ' ').trim(); return c.length <= n ? c : c.slice(0, n) + '…'; }
function ri(t: TreeNode['type']) { const m: Record<string,string> = { system:'💡', user:'👤', assistant:'🤖', reasoning:'💭', 'tool-call':'⚙', 'tool-result':'📋', streaming:'⏳' }; return m[t] ?? '•'; }

/**
 * 从 messageTree 中按 DFS 收集所有消息（活跃分支优先，非活跃分支在后）。
 * 确保分支总览视图能看到所有分支的消息。
 */
function collectAllMessages(
  messageTree: Record<string, Message>,
  rootMessageId: string | null,
  activePathIds: Set<string>,
): Message[] {
  if (!rootMessageId) return [];

  const result: Message[] = [];
  const visited = new Set<string>();

  function dfs(msgId: string) {
    if (visited.has(msgId)) return;
    visited.add(msgId);
    const msg = messageTree[msgId];
    if (!msg) return;

    result.push(msg);

    // 收集所有子节点，活跃路径上的排在最前
    const children = Object.values(messageTree).filter(m => m.parentId === msgId);
    children.sort((a, b) => {
      const aActive = activePathIds.has(a.id) ? 0 : 1;
      const bActive = activePathIds.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.timestamp - b.timestamp;
    });
    for (const child of children) {
      dfs(child.id);
    }
  }

  dfs(rootMessageId);
  return result;
}

function buildTree(
  msgs: Message[],
  messageTree: Record<string, Message>,
  roundMap: Map<string, { roundIndex: number; roundPosition: 'start' | 'middle' | 'end' | 'standalone' }>,
  density: number, // label max chars
  currentId?: string,
  isStreaming?: boolean,
  viewMessageIds?: Set<string>,
  execMessageIds?: Set<string>,
): TreeNode[] {
  const trMap = new Map<string, { result: string; name: string; isError: boolean }>();
  const tcMsgMap = new Map<string, string>(); // toolCallId → tool 消息的 id
  for (const m of msgs) {
    if (m.role === 'tool' && m.toolResult) {
      trMap.set(m.toolResult.toolCallId, { result: m.toolResult.result, name: m.toolResult.name, isError: m.toolResult.isError });
      tcMsgMap.set(m.toolResult.toolCallId, m.id);
    }
  }
  const nodes: TreeNode[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const cur = m.id === currentId;
    const stream = isStreaming && m.role === 'assistant' && m.id === currentId;
    const exec = execMessageIds ? execMessageIds.has(m.id) : false;
    if (m.role === 'system') { nodes.push({ id: `sys-${m.id}`, type: 'system', messageId: m.id, label: trunc(m.content, density), children: [], isCurrent: cur, isStreaming: false, isExecuting: exec, isInactive: (viewMessageIds || execMessageIds) ? !(viewMessageIds?.has(m.id) || execMessageIds?.has(m.id)) : false }); continue; }
    if (m.role === 'user') { nodes.push({ id: `u-${m.id}`, type: 'user', messageId: m.id, label: trunc(m.content, density), children: [], isCurrent: cur, isStreaming: false, isExecuting: exec, isInactive: (viewMessageIds || execMessageIds) ? !(viewMessageIds?.has(m.id) || execMessageIds?.has(m.id)) : false }); continue; }
    if (m.role === 'assistant') {
      const ch: TreeNode[] = [];
      // 构建助理节点的子标签：推理内容预览 + 阶段
      let sublabel = '';
      let assistantPhase: TreeNode['assistantPhase'] = undefined;
      const hasReasoning = !!m.reasoning;
      const hasToolCalls = !!(m.toolCalls?.length);
      const hasContent = !!m.content;

      if (hasToolCalls) {
        assistantPhase = 'tool-calling';
        if (hasReasoning) {
          const preview = trunc(m.reasoning.replace(/\s+/g, ' '), 22);
          sublabel = `💭 ${preview}`;
        }
      } else if (hasReasoning && !hasContent) {
        assistantPhase = 'thinking';
        const preview = trunc(m.reasoning.replace(/\s+/g, ' '), 24);
        sublabel = `💭 ${preview}`;
      } else if (hasContent && !hasReasoning) {
        assistantPhase = 'answering';
      } else if (hasContent && hasReasoning) {
        // 混合情况：有推理也有内容 → 视为推理+回答
        assistantPhase = 'thinking';
        const preview = trunc(m.reasoning.replace(/\s+/g, ' '), 18);
        sublabel = `💭 ${preview}`;
      }

      // MCP 轮次信息从 roundMap（树结构计算结果）查询
      const roundInfo = roundMap.get(m.id);
      const curRoundIdx = roundInfo?.roundIndex;
      const curRoundPosition = roundInfo?.roundPosition;

      // 工具调用 → 每个工具调用和其返回结果合并为一个扁平节点
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          const tr = trMap.get(tc.id);
          let ap = ''; try { const p = JSON.parse(tc.arguments); ap = Object.values(p).map(String).join(', '); if (ap.length > 28) ap = ap.slice(0, 28) + '…'; } catch { ap = tc.arguments; }
          // 合并后的工具节点：标签 = 工具名，子标签 = 参数摘要 + 结果摘要
          let toolSublabel = ap;
          let toolIsError = false;
          if (tr) {
            // 显示结果摘要（而非重复工具名），带 ✓/✕ 状态前缀
            const resultPreview = trunc(tr.result.replace(/\n/g, ' '), 28);
            toolSublabel = (tr.isError ? '✕ ' : '✓ ') + resultPreview;
            toolIsError = tr.isError;
          }
          ch.push({
            id: `tc-${tc.id}`,
            type: 'tool-call',
            messageId: tcMsgMap.get(tc.id) ?? m.id,
            label: tc.name,
            sublabel: toolSublabel,
            children: [],
            roundIndex: curRoundIdx,
            isCurrent: false,
            isStreaming: false,
            isExecuting: false,
            isInactive: false, // 工具节点不参与分支淡化
            isError: toolIsError,
          });
        }
      }

      const isInactive = (viewMessageIds || execMessageIds) ? !(viewMessageIds?.has(m.id) || execMessageIds?.has(m.id)) : false;
      const node: TreeNode = {
        id: `a-${m.id}`, type: 'assistant', messageId: m.id,
        label: trunc(m.content, density),
        sublabel: sublabel || undefined,
        children: ch,
        assistantPhase,
        roundIndex: curRoundIdx,
        roundPosition: curRoundPosition,
        isCurrent: cur, isStreaming: stream,
        isExecuting: exec,
        isInactive,
      };
      // 工具子节点继承父节点的分支淡化状态
      if (isInactive) {
        for (const child of ch) {
          child.isInactive = true;
        }
      }
      nodes.push(node);
      continue;
    }
    if (m.role === 'tool') {
      const orphan = m.toolResult?.toolCallId ? !msgs.some(m2 => m2.role === 'assistant' && m2.toolCalls?.some(tc => tc.id === m.toolResult!.toolCallId)) : true;
      if (orphan && m.toolResult) {
        // 孤立的 tool 节点：从子节点 assistant 的 roundMap 推导 roundIndex
        let toolRI: number | undefined;
        const childMsgs = Object.values(messageTree).filter(c => c.parentId === m.id);
        for (const child of childMsgs) {
          const cr = roundMap.get(child.id);
          if (cr) { toolRI = cr.roundIndex; break; }
        }
        nodes.push({ id: `t-${m.id}`, type: 'tool-result', messageId: m.id, label: trunc(m.toolResult.result, density), sublabel: (m.toolResult.isError ? '✕ ' : '✓ ') + m.toolResult.name, children: [], roundIndex: toolRI, isCurrent: cur, isStreaming: false, isExecuting: false, isInactive: false, isError: m.toolResult.isError });
      }
    }
  }
  return nodes;
}

// ── layout：多叉树布局（自上而下，兄弟节点水平并排）────

/**
 * 真正的多叉树布局：
 *   - 父节点在上，子节点在下水平展开
 *   - 父节点居中于所有子节点上方
 *   - 同一父节点的多个子分支水平并排，清晰展示树状分叉
 *   - 工具调用节点作为消息节点的附属，紧贴其下方
 */
function layout(
  treeNodes: TreeNode[],
  messageTree: Record<string, Message>,
  rootMessageId: string | null,
  viewMessageIds?: Set<string>,
): { layoutNodes: LayoutNode[]; edges: TreeEdge[]; canvasW: number; canvasH: number } {
  const ln: LayoutNode[] = [];
  const edges: TreeEdge[] = [];

  // messageId → TreeNode 快速查找
  const tnMap = new Map<string, TreeNode>();
  for (const tn of treeNodes) {
    if (tn.messageId) tnMap.set(tn.messageId, tn);
  }

  // ── 获取排序后的子节点列表（与 collectAllMessages 一致）──
  function getSortedChildren(parentId: string | null): Message[] {
    return Object.values(messageTree)
      .filter(m => m.parentId === parentId)
      .sort((a, b) => {
        const aActive = viewMessageIds?.has(a.id) ? 0 : 1;
        const bActive = viewMessageIds?.has(b.id) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.timestamp - b.timestamp;
      });
  }

  /**
   * 获取"有效的"子节点列表：递归跳过没有 TreeNode 的消息
   * （如非孤立的 tool 消息，已在 assistant 的 toolChildren 中展示），
   * 将其子节点上提一级，避免布局中出现无 TreeNode 的节点导致崩溃。
   */
  function getEffectiveChildren(parentId: string | null): Message[] {
    const direct = getSortedChildren(parentId);
    const result: Message[] = [];
    for (const child of direct) {
      if (tnMap.has(child.id)) {
        result.push(child);
      } else {
        // 无 TreeNode → 上提其子节点
        const promoted = getEffectiveChildren(child.id);
        result.push(...promoted);
      }
    }
    return result;
  }

  // ── 递归计算子树宽度 ───────────────────────────────
  const subtreeWidthMap = new Map<string, number>();

  function calcSubtreeWidth(msgId: string): number {
    const cached = subtreeWidthMap.get(msgId);
    if (cached !== undefined) return cached;

    const children = getEffectiveChildren(msgId);
    if (children.length === 0) {
      subtreeWidthMap.set(msgId, NODE_W);
      return NODE_W;
    }

    let total = 0;
    for (const child of children) {
      total += calcSubtreeWidth(child.id);
    }
    total += (children.length - 1) * H_GAP;
    const result = Math.max(NODE_W, total);
    subtreeWidthMap.set(msgId, result);
    return result;
  }

  // ── 递归布局节点 ─────────────────────────────────
  function placeTree(
    msgId: string,
    left: number,
    depth: number,
    inheritedExtraY: number = 0,
    parentRoundIndex?: number,
    /** 从根到父节点的 (nodeH+gap) 累加和，替代 depth×gap 避免非线性累积 */
    accumulatedOffset: number = 0,
  ): { centerX: number; width: number } {
    const tn = tnMap.get(msgId);
    const children = getEffectiveChildren(msgId);

    // 防御：没有 TreeNode 的消息（不应发生，但防止崩溃）
    if (!tn) {
      // 作为透明节点：不创建布局节点，仅传递子节点
      if (children.length === 0) return { centerX: left, width: 0 };
      let childLeft = left;
      let totalW = 0;
      for (const child of children) {
        // 透明节点不贡献高度/间距，accumulatedOffset 不变
        const r = placeTree(child.id, childLeft, depth, inheritedExtraY, undefined, accumulatedOffset);
        childLeft += r.width + H_GAP;
        totalW += r.width;
      }
      totalW += (children.length - 1) * H_GAP;
      return { centerX: left + totalW / 2, width: totalW };
    }

    // y = 顶部内边距 + 祖先节点高度+间距累计 + 祖先工具节点高度
    // MCP 轮次内部（start/middle）用紧凑间距，轮次结尾（end/standalone）用正常间距
    const isRoundInternal = tn?.roundPosition === 'start' || tn?.roundPosition === 'middle';
    const gap = isRoundInternal ? ROUND_V_GAP : V_GAP;
    const isCompact = tn?.compact === true;
    const nodeH = isCompact ? TOOL_NODE_H : NODE_H;
    const y = PAD_TOP + accumulatedOffset + inheritedExtraY;

    // 本节点贡献的偏移量 = 自身高度 + 间距，传递给子节点
    const selfOffset = nodeH + gap;

    // 计算本节点工具调用子节点占据的额外高度（传递给后代）
    const toolChildren = tn?.children ?? [];
    const tpr = toolsPerRow();
    const toolRows = toolChildren.length > 0 ? Math.ceil(toolChildren.length / tpr) : 0;
    const toolExtraH = toolRows > 0
      ? toolRows * TOOL_NODE_H + (toolRows - 1) * CHILD_GAP + CHILD_GAP
      : 0;

    if (children.length === 0) {
      // ── 叶子节点 ──
      const cx = left + NODE_W / 2;
      const nodeLeft = cx - NODE_W / 2;
      const node = { id: tn?.id ?? `msg-${msgId}`, treeNode: tn!, x: nodeLeft, y, w: NODE_W, h: nodeH };
      ln.push(node);

      // 叶子节点的工具调用子节点（水平网格排列，自动换行）
      if (toolChildren.length > 0) {
        const tpr = toolsPerRow();
        const effectiveCols = Math.min(tpr, toolChildren.length);
        const totalRowW = effectiveCols * TOOL_COMPACT_W + (effectiveCols - 1) * TOOL_GAP_X;
        const startX = nodeLeft + (NODE_W - totalRowW) / 2;
        for (let i = 0; i < toolChildren.length; i++) {
          const row = Math.floor(i / effectiveCols);
          const col = i % effectiveCols;
          const tx = startX + col * (TOOL_COMPACT_W + TOOL_GAP_X);
          const ty = y + nodeH + CHILD_GAP + row * (TOOL_NODE_H + CHILD_GAP);
          ln.push({
            id: toolChildren[i].id,
            treeNode: toolChildren[i],
            x: tx, y: ty,
            w: TOOL_COMPACT_W, h: TOOL_NODE_H,
          });
        }
      }

      return { centerX: cx, width: NODE_W };
    }

    // ── 内部节点：先递归放置子节点 ──
    // 子节点继承：祖先节点偏移 + 本节点偏移 + 工具高度
    const childInheritedY = inheritedExtraY + toolExtraH;
    const childAccumulatedOffset = accumulatedOffset + selfOffset;
    let childLeft = left;
    const childResults: { msgId: string; centerX: number; width: number }[] = [];

    for (const child of children) {
      const result = placeTree(child.id, childLeft, depth + 1, childInheritedY, tn?.roundIndex, childAccumulatedOffset);
      childResults.push({ msgId: child.id, centerX: result.centerX, width: result.width });
      childLeft += result.width + H_GAP;
    }

    // 子树总宽度 = 最后一个子节点右边界 - left
    const totalWidth = childLeft - H_GAP - left;
    const parentWidth = Math.max(NODE_W, totalWidth);
    const cx = left + parentWidth / 2;

    // 父节点
    const nodeLeft = cx - NODE_W / 2;
    const node = { id: tn?.id ?? `msg-${msgId}`, treeNode: tn!, x: nodeLeft, y, w: NODE_W, h: nodeH };
    ln.push(node);

    // 父节点的工具调用子节点（水平网格排列，自动换行）
    if (toolChildren.length > 0) {
      const tpr = toolsPerRow();
      const effectiveCols = Math.min(tpr, toolChildren.length);
      const totalRowW = effectiveCols * TOOL_COMPACT_W + (effectiveCols - 1) * TOOL_GAP_X;
      const startX = nodeLeft + (NODE_W - totalRowW) / 2;
      for (let i = 0; i < toolChildren.length; i++) {
        const row = Math.floor(i / effectiveCols);
        const col = i % effectiveCols;
        const tx = startX + col * (TOOL_COMPACT_W + TOOL_GAP_X);
        const ty = y + nodeH + CHILD_GAP + row * (TOOL_NODE_H + CHILD_GAP);
        ln.push({
          id: toolChildren[i].id,
          treeNode: toolChildren[i],
          x: tx, y: ty,
          w: TOOL_COMPACT_W, h: TOOL_NODE_H,
        });
      }
    }

    // ── 生成边：从父节点到每个子节点 ──
    const parentBotY = y + nodeH;
    for (const child of childResults) {
      const childNode = ln.find(l => l.treeNode?.messageId === child.msgId);
      if (!childNode) continue;
      edges.push({
        fromId: node.id,
        toId: childNode.id,
        x1: cx,
        y1: parentBotY,
        x2: child.centerX,
        y2: childNode.y,
      });
    }

    return { centerX: cx, width: parentWidth };
  }

  // ── 从根开始布局 ──
  if (!rootMessageId || !messageTree[rootMessageId]) {
    return { layoutNodes: [], edges: [], canvasW: 400, canvasH: 300 };
  }

  // 先计算整棵树的总宽度
  const totalWidth = calcSubtreeWidth(rootMessageId);

  // 递归放置所有节点
  placeTree(rootMessageId, PAD_SIDE, 0);

  // 计算画布高度：找到最底部的节点
  let maxBot = PAD_TOP;
  for (const n of ln) {
    const bottom = n.y + n.h;
    if (bottom > maxBot) maxBot = bottom;
  }

  // ── 标记分支边：同一父节点有多个子边时，这些边即为分支分叉 ──
  const fromCounts = new Map<string, number>();
  for (const e of edges) {
    fromCounts.set(e.fromId, (fromCounts.get(e.fromId) ?? 0) + 1);
  }
  for (const e of edges) {
    if ((fromCounts.get(e.fromId) ?? 0) > 1) {
      e.isBranch = true;
    }
  }

  const canvasW = totalWidth + PAD_SIDE * 2;
  const canvasH = maxBot + PAD_TOP;

  return { layoutNodes: ln, edges, canvasW, canvasH };
}

// ── computeRoundGroups ────────────────────────────────────

/**
 * 从布局节点中提取所有 roundIndex 非空的节点，
 * 按 roundIndex 分组并计算每个 round 的包围盒，
 * 用于在画布上绘制 MCP 轮次分组背景。
 *
 * 只有节点数 >= 2 的 round 才会生成分组，
 * standalone（单节点）不生成背景以避免视觉噪音。
 */
function computeRoundGroups(layoutNodes: LayoutNode[]): RoundGroup[] {
  const groups = new Map<number, LayoutNode[]>();

  for (const ln of layoutNodes) {
    const ri = ln.treeNode?.roundIndex;
    if (ri !== undefined && ri !== null) {
      if (!groups.has(ri)) groups.set(ri, []);
      groups.get(ri)!.push(ln);
    }
  }

  const result: RoundGroup[] = [];
  for (const [index, nodes] of groups) {
    // 跳过单节点 round（无实际分组意义）
    const positions = nodes.map(n => n.treeNode.roundPosition).filter(Boolean);
    const uniquePositions = new Set(positions);
    if (nodes.length < 2 && uniquePositions.has('standalone')) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }

    // 推断轮次位置：取第一个节点的 roundPosition
    const firstPosition = nodes.find(n => n.treeNode.roundPosition)?.treeNode.roundPosition ?? 'standalone';

    result.push({
      roundIndex: index,
      x: minX - 14,
      y: minY - 10,
      w: maxX - minX + 28,
      h: maxY - minY + 20,
      label: `MCP 轮 #${index}`,
      position: firstPosition,
    });
  }

  return result;
}

// ── collapseToolSections ──────────────────────────────────

/**
 * 将助理节点（及其工具子节点）折叠为一条极简摘要条。
 * 折叠后助理节点被替换为一个 28px 高的紧凑条，
 * 显示：轮次编号、工具调用统计、思考预览。
 * 展开后恢复完整的助理+工具子节点详情。
 */
function collapseToolSections(treeNodes: TreeNode[], collapsedIds: Set<string>): TreeNode[] {
  return treeNodes.map(tn => {
    if (tn.type === 'assistant' && tn.children.length > 0 && collapsedIds.has(tn.id)) {
      const total = tn.children.length;
      const success = tn.children.filter(c => !c.isError).length;
      const fail = total - success;
      // 从原助理节点的 sublabel 中取思考预览（去掉 💭 前缀）
      const reasoningHint = (tn.sublabel ?? '').replace(/^💭\s*/, '').slice(0, 14);
      const roundTag = tn.roundIndex ? `#${tn.roundIndex}` : '';
      const phaseIcon = tn.assistantPhase === 'answering' ? '💬' : '🟣';
      return {
        ...tn,
        label: `${roundTag} ⚙${total} ✓${success}${fail > 0 ? `✕${fail}` : ''}`,
        sublabel: reasoningHint ? `💭 ${reasoningHint}…` : undefined,
        children: [],
        compact: true,
      };
    }
    return tn;
  });
}

// ── collapseRounds ───────────────────────────────────────

/**
 * 将整个 MCP 轮次折叠为一条汇总节点。
 * 同一 roundIndex 的所有助理节点合并为一条，显示总工具调用统计。
 * 展开后恢复各助理的独立摘要条。
 *
 * 依赖 getEffectiveChildren 的"跳过无 TreeNode 消息"机制：
 * 被移除的节点在 tnMap 中不存在，其子节点自动上提一级，
 * 因此轮次汇总节点直接连接到轮次后的下一条消息。
 */
function collapseRounds(treeNodes: TreeNode[], collapsedRounds: Set<number>): TreeNode[] {
  if (collapsedRounds.size === 0) return treeNodes;

  // 按 roundIndex 分组
  const roundGroups = new Map<number, TreeNode[]>();
  for (const tn of treeNodes) {
    if (tn.roundIndex !== undefined && tn.type === 'assistant') {
      if (!roundGroups.has(tn.roundIndex)) roundGroups.set(tn.roundIndex, []);
      roundGroups.get(tn.roundIndex)!.push(tn);
    }
  }

  const toRemove = new Set<string>();
  const replacements = new Map<string, TreeNode>();

  for (const [roundIdx, nodes] of roundGroups) {
    if (!collapsedRounds.has(roundIdx) || nodes.length === 0) continue;

    // 收集该轮所有工具调用统计
    let total = 0, success = 0, fail = 0;
    for (const n of nodes) {
      // 工具子节点可能在 collapseToolSections 中被清空，
      // 但 compact 节点的 label 里还保留着统计信息
      const tcCount = n.children.filter(c => c.type === 'tool-call').length;
      if (tcCount > 0) {
        total += tcCount;
        success += n.children.filter(c => c.type === 'tool-call' && !c.isError).length;
        fail += n.children.filter(c => c.type === 'tool-call' && c.isError).length;
      } else if (n.compact) {
        // 已折叠的节点，从 label 中解析统计
        const m = n.label.match(/⚙(\d+)\s*✓(\d+)(?:✕(\d+))?/);
        if (m) {
          total += parseInt(m[1]);
          success += parseInt(m[2]);
          fail += m[3] ? parseInt(m[3]) : 0;
        }
      }
    }

    // 以最后一条节点为基础创建轮次汇总（保留首条节点的 id 以维持树结构）
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    // 取最后一条节点的正文内容作为摘要预览（而非推理）
    const lastContentPreview = last.label?.slice(0, 28) || '';
    // 若轮次内任意节点在执行路径上或正在流式输出，汇总节点也继承该状态
    const anyExecuting = nodes.some(n => n.isExecuting);
    const anyStreaming = nodes.some(n => n.isStreaming);
    const anyCurrent = nodes.some(n => n.isCurrent);
    const anyActive = nodes.some(n => !n.isInactive);
    const summary: TreeNode = {
      ...first,
      // 保留 first.id 用于布局中的节点定位
      label: `MCP 轮 #${roundIdx}  ⚙${total} ✓${success}${fail > 0 ? `✕${fail}` : ''}`,
      sublabel: lastContentPreview ? `${lastContentPreview}…  点击展开` : '点击展开此轮详情',
      assistantPhase: last.assistantPhase,  // 最后一条的阶段
      /** 汇总节点代表整个轮次结尾，使用正常间距 V_GAP */
      roundPosition: 'end',
      children: [],
      compact: true,
      isCurrent: anyCurrent,
      isExecuting: anyExecuting,
      isStreaming: anyStreaming,
      isInactive: !anyActive,
    };

    replacements.set(first.id, summary);
    for (const n of nodes.slice(1)) {
      toRemove.add(n.id);
    }
  }

  return treeNodes
    .filter(tn => !toRemove.has(tn.id))
    .map(tn => replacements.get(tn.id) ?? tn);
}

// ── 组件 ──────────────────────────────────────────────────

interface Props {
  /** 全量消息树（用于分支总览） */
  messageTree: Record<string, Message>;
  /** 根消息 ID */
  rootMessageId: string | null;
  /** 当前视图路径上的消息 ID 集合（用于高亮视图分支、淡化非活跃分支） */
  viewMessageIds: Set<string>;
  /** 当前执行路径上的消息 ID 集合（流式期间与视图路径可能不同，用于绿色左边框标记） */
  execMessageIds?: Set<string>;
  currentMessageId?: string;
  isStreaming?: boolean;
  onNavigate: (messageId: string) => void;
  onClose: () => void;
  /** 右键菜单操作回调 */
  onEdit?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onCopy?: (messageId: string) => void;
  onContinueFrom?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  /** 批量删除（多选模式下触发） */
  onDeleteMultiple?: (messageIds: string[]) => void;
  onBranchSwitch?: (sessionId: string, leafId: string) => void;
  currentSessionId?: string | null;
}

// ── 工具函数：计算默认折叠状态 ────────────────────────

function computeDefaultCollapsedRounds(
  messageTree: Record<string, Message>,
  rootMessageId: string | null,
): Set<number> {
  const roundMap = computeRoundMap(messageTree, rootMessageId);
  const rounds = new Set<number>();
  for (const info of roundMap.values()) {
    rounds.add(info.roundIndex);
  }
  return rounds;
}

export default function ConversationTree({ messageTree, rootMessageId, viewMessageIds, execMessageIds, currentMessageId, isStreaming, onNavigate, onClose, onEdit, onRetry, onCopy, onContinueFrom, onDelete, onDeleteMultiple, onBranchSwitch, currentSessionId }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef({ sx: 0, sy: 0, otx: 0, oty: 0 });
  /** 是否已完成首次居中，防止数据变化时覆盖用户拖拽/缩放状态 */
  const hasCenteredRef = useRef(false);

  // ── 多选 & 框选状态 ─────────────────────────────────
  /** 已选中的节点 messageId 集合 */
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  /** 是否正在框选拖拽（ref 用于同步判定，避免事件闭包延迟） */
  const boxSelectingRef = useRef(false);
  const boxRef = useRef({ startX: 0, startY: 0, endX: 0, endY: 0 });
  /** 框选起始位置（屏幕坐标，相对于画布容器） */
  const [boxRect, setBoxRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  /** 清除所有选中 */
  const clearSelection = useCallback(() => setSelectedNodeIds(new Set()), []);

  // 切换后代节点选中后，同步清理不存在的 messageId
  useEffect(() => {
    if (selectedNodeIds.size === 0) return;
    let needsClean = false;
    for (const id of selectedNodeIds) {
      if (!messageTree[id]) { needsClean = true; break; }
    }
    if (needsClean) {
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        for (const id of prev) { if (!messageTree[id]) next.delete(id); }
        return next;
      });
    }
  }, [messageTree, selectedNodeIds]);

  /** 已折叠的工具链节点 ID 集合（助理节点 ID）—— 默认不折叠，用户按需折叠 */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set<string>());

  /** 已折叠的 MCP 轮次（roundIndex 集合），整轮收为一条汇总 */
  const [collapsedRounds, setCollapsedRounds] = useState<Set<number>>(() => {
    return computeDefaultCollapsedRounds(messageTree, rootMessageId);
  });

  /** 右键菜单状态：null=关闭，否则记录菜单位置和目标消息 ID */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
    /** 该消息是否有多个分支 */
    hasMultiBranch: boolean;
    /** 该消息的角色 */
    role: Message['role'];
    /** 是否处于多选模式（多个节点被选中且右键节点在选中集合中） */
    isMultiSelect: boolean;
    /** 多选模式下选中的消息 ID 列表 */
    selectedIds: string[];
  } | null>(null);

  /** 关闭右键菜单 */
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /** Escape 键清除选中状态 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu) { closeContextMenu(); return; }
        if (selectedNodeIds.size > 0) clearSelection();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu, closeContextMenu, selectedNodeIds, clearSelection]);

  /** 点击画布其他区域关闭菜单（原生事件，需排除菜单内部点击） */
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      // 如果点击在菜单内部，不关闭（React 合成事件的 stopPropagation 无法阻止原生事件冒泡）
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      closeContextMenu();
    };
    const el = canvasRef.current;
    el?.addEventListener('mousedown', handler);
    return () => el?.removeEventListener('mousedown', handler);
  }, [contextMenu, closeContextMenu]);

  /** 右键消息节点，弹出上下文菜单 */
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, messageId: string, role: Message['role']) => {
    e.preventDefault();
    e.stopPropagation();
    if (!messageTree[messageId]) return;
    // 计算分支数
    const children = Object.values(messageTree).filter(m => m.parentId === messageId);
    const hasMultiBranch = children.length > 1;
    // 获取画布容器位置
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // 判断是否处于多选模式
    const currentSelection = selectedNodeIds;
    const isInSelection = currentSelection.has(messageId);
    const hasMultiSelection = currentSelection.size > 1;

    // 如果右键点击的节点不在当前选中集合中，清除旧选中并单选此节点
    if (!isInSelection) {
      setSelectedNodeIds(new Set([messageId]));
    }

    const isMultiSelect = hasMultiSelection && isInSelection;
    const selectedIds = isMultiSelect ? Array.from(currentSelection) : [messageId];

    setContextMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      messageId,
      hasMultiBranch,
      role,
      isMultiSelect,
      selectedIds,
    });
  }, [messageTree, selectedNodeIds]);

  /** 切换折叠/展开 */
  const toggleCollapse = useCallback((nodeId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  /** 切换整轮折叠/展开 */
  const toggleRoundCollapse = useCallback((roundIndex: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCollapsedRounds(prev => {
      const next = new Set(prev);
      if (next.has(roundIndex)) next.delete(roundIndex);
      else next.add(roundIndex);
      return next;
    });
  }, []);

  // 🔧 从 messageTree 收集所有消息（DFS 遍历，活跃分支优先）
  const allMessages = useMemo(
    () => collectAllMessages(messageTree, rootMessageId, viewMessageIds),
    [messageTree, rootMessageId, viewMessageIds]
  );

  // 密度：根据消息总数自适应
  const density = allMessages.length <= 20 ? 35 : allMessages.length <= 60 ? 20 : 12;

  // 🚀 流式性能优化：树结构 key（仅含节点 ID 和 parentId，不含文本内容）
  // 流式过程中仅文本变化，结构不变，不应触发昂贵的 layout 重算
  const treeStructureKey = useMemo(() => {
    const ids = Object.keys(messageTree).sort();
    return ids.map(id => `${id}:${messageTree[id].parentId ?? 'null'}:${messageTree[id].role}`).join('|');
  }, [messageTree]);

  // MCP 轮次映射：纯树结构驱动，不依赖收集顺序
  const roundMap = useMemo(
    () => computeRoundMap(messageTree, rootMessageId),
    [messageTree, rootMessageId]
  );

  /** 缓存上次布局结果，流式期间结构不变时复用 */
  const layoutCacheRef = useRef<{ key: string; nodes: LayoutNode[]; edges: TreeEdge[]; w: number; h: number } | null>(null);

  // 构建 → 单节折叠 → 整轮折叠 → 布局
  const { layoutNodes, edges, canvasW, canvasH } = useMemo(() => {
    const rawTree = buildTree(allMessages, messageTree, roundMap, density, currentMessageId, isStreaming, viewMessageIds, execMessageIds);
    const collapsed = collapseToolSections(rawTree, collapsedSections);
    const rounded = collapseRounds(collapsed, collapsedRounds);

    // 🚀 流式期间结构+折叠未变 → 复用缓存布局（跳过昂贵的 layout 计算）
    const collapseKey = `${[...collapsedSections].sort().join(',')}|${[...collapsedRounds].sort().join(',')}`;
    const fullCacheKey = `${treeStructureKey}||${collapseKey}`;
    if (layoutCacheRef.current && layoutCacheRef.current.key === fullCacheKey && isStreaming) {
      return layoutCacheRef.current;
    }

    const result = layout(rounded, messageTree, rootMessageId, viewMessageIds);
    // 结构/折叠变化或非流式 → 更新缓存
    if (!isStreaming || layoutCacheRef.current?.key !== fullCacheKey) {
      layoutCacheRef.current = { key: fullCacheKey, ...result };
    }
    return result;
  }, [allMessages, density, currentMessageId, isStreaming, viewMessageIds, execMessageIds, collapsedSections, collapsedRounds, treeStructureKey]);

  // MCP 轮次分组（基于布局节点计算）
  const roundGroups = useMemo(() => computeRoundGroups(layoutNodes), [layoutNodes]);

  /** 折叠组的展开映射：折叠代表节点的 messageId → 该组包含的所有实际 messageId
   *  用于框选时正确统计被折叠节点下的所有子节点 */
  const collapsedGroupExpandMap = useMemo(() => {
    const map = new Map<string, string[]>();

    // ── 1. 单节折叠（collapsedSections）：助理节点 → 助理 + 所有工具子节点 ──
    for (const nodeId of collapsedSections) {
      // nodeId 格式为 "a-{messageId}"
      const msgId = nodeId.startsWith('a-') ? nodeId.slice(2) : null;
      if (!msgId || !messageTree[msgId]) continue;
      // 找到该助理节点的所有 tool 子节点
      const toolChildIds = Object.values(messageTree)
        .filter(m => m.parentId === msgId && m.role === 'tool')
        .map(m => m.id);
      map.set(msgId, [msgId, ...toolChildIds]);
    }

    // ── 2. 整轮折叠（collapsedRounds）：汇总节点（第一个 assistant）→ 该轮次所有 assistant 节点 ──
    if (collapsedRounds.size > 0) {
      // 从 roundMap（树结构计算）获取 roundIndex → [messageId, ...] 映射
      const roundMsgs = new Map<number, string[]>();
      for (const [msgId, info] of roundMap) {
        if (!roundMsgs.has(info.roundIndex)) roundMsgs.set(info.roundIndex, []);
        roundMsgs.get(info.roundIndex)!.push(msgId);
      }
      // 将折叠轮次的信息写入 map
      for (const [roundIdx, msgIds] of roundMsgs) {
        if (collapsedRounds.has(roundIdx) && msgIds.length > 0) {
          map.set(msgIds[0], msgIds); // 第一个 assistant 的 messageId → 所有 messageId
        }
      }
    }

    return map;
  }, [collapsedSections, collapsedRounds, allMessages, messageTree, roundMap]);

  // 仅在切换会话（rootMessageId 变化）时允许重新居中，
  // 同一会话内新增/删除节点不重置，保留用户的缩放和位置
  useEffect(() => {
    hasCenteredRef.current = false;
  }, [rootMessageId]);

  // 初始居中：等所有数据就绪后适配视口
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !layoutNodes.length || hasCenteredRef.current) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    // 找到根节点（第一个放置的节点，y 最小的节点）
    const rootLn = [...layoutNodes].sort((a, b) => a.y - b.y)[0];
    if (!rootLn) return;
    const rootCx = rootLn.x + rootLn.w / 2;
    // 按 canvas 比例缩放，确保整棵树可见
    const scaleX = (cw - 80) / (canvasW || 400);
    const scaleY = (ch - 80) / (canvasH || 300);
    const initScale = Math.min(scaleX, scaleY, 1);
    setView({ scale: initScale, tx: cw / 2 - rootCx * initScale, ty: 30 });
    hasCenteredRef.current = true;
  }, [layoutNodes, canvasW, canvasH]);

  // ── 事件 ──────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 点击节点不触发平移或框选
    if ((e.target as HTMLElement).closest('[data-node-id]')) return;

    // 右键拖拽 = 平移
    if (e.button === 2) {
      e.preventDefault();
      setPanning(true);
      panRef.current = { sx: e.clientX, sy: e.clientY, otx: view.tx, oty: view.ty };
      return;
    }

    // 左键拖拽 = 框选
    if (e.button === 0) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      boxRef.current = { startX: sx, startY: sy, endX: sx, endY: sy };
      setBoxRect({ x: sx, y: sy, w: 0, h: 0 });
      boxSelectingRef.current = true;
      return;
    }
  }, [view]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (boxSelectingRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ex = e.clientX - rect.left;
      const ey = e.clientY - rect.top;
      boxRef.current = { ...boxRef.current, endX: ex, endY: ey };
      const x = Math.min(boxRef.current.startX, ex);
      const y = Math.min(boxRef.current.startY, ey);
      const w = Math.abs(ex - boxRef.current.startX);
      const h = Math.abs(ey - boxRef.current.startY);
      setBoxRect({ x, y, w, h });
      return;
    }
    if (!panning) return;
    setView(v => ({ ...v, tx: panRef.current.otx + (e.clientX - panRef.current.sx), ty: panRef.current.oty + (e.clientY - panRef.current.sy) }));
  }, [panning]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (boxSelectingRef.current) {
      boxSelectingRef.current = false;
      setBoxRect(null);

      // 只在框选矩形足够大（> 4px）时才执行框选计算
      const bw = Math.abs(boxRef.current.endX - boxRef.current.startX);
      const bh = Math.abs(boxRef.current.endY - boxRef.current.startY);
      if (bw < 4 && bh < 4) {
        // 点击空白区域 → 清除选中
        clearSelection();
        return;
      }

      // 将框选矩形从屏幕坐标转换到画布坐标
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = Math.min(boxRef.current.startX, boxRef.current.endX);
      const sy = Math.min(boxRef.current.startY, boxRef.current.endY);
      const ex = Math.max(boxRef.current.startX, boxRef.current.endX);
      const ey = Math.max(boxRef.current.startY, boxRef.current.endY);

      // 屏幕坐标 → 画布坐标（逆向 view transform）
      const toCanvasX = (sx: number) => (sx - view.tx) / view.scale;
      const toCanvasY = (sy: number) => (sy - view.ty) / view.scale;

      const cx1 = toCanvasX(sx);
      const cy1 = toCanvasY(sy);
      const cx2 = toCanvasX(ex);
      const cy2 = toCanvasY(ey);

      // 与 layoutNodes 做交集检测
      const newSelection = new Set<string>();
      for (const ln of layoutNodes) {
        if (!ln.treeNode?.messageId) continue;
        // 矩形与节点矩形是否相交
        if (ln.x + ln.w > cx1 && ln.x < cx2 && ln.y + ln.h > cy1 && ln.y < cy2) {
          const msgId = ln.treeNode.messageId;
          // 如果该节点是折叠组的代表节点（compact），展开为组内所有实际消息 ID
          if (ln.treeNode.compact && collapsedGroupExpandMap.has(msgId)) {
            const expanded = collapsedGroupExpandMap.get(msgId)!;
            for (const eid of expanded) {
              newSelection.add(eid);
            }
          } else {
            newSelection.add(msgId);
          }
        }
      }
      setSelectedNodeIds(newSelection);
      return;
    }

    // 平移结束：如果没有明显移动（< 3px），视为点击空白区域，清除选中
    if (panning) {
      const dx = Math.abs(e.clientX - panRef.current.sx);
      const dy = Math.abs(e.clientY - panRef.current.sy);
      if (dx < 3 && dy < 3) {
        clearSelection();
      }
    }
    setPanning(false);
  }, [panning, view, clearSelection, layoutNodes, collapsedGroupExpandMap]);

  /** 阻止画布空白区域的右键菜单 */
  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    // 节点上的右键由节点自己的 onContextMenu 处理
    if ((e.target as HTMLElement).closest('[data-node-id]')) return;
    e.preventDefault();
  }, []);

  // 使用原生 addEventListener 注册 wheel 事件，
  // 并指定 { passive: false }，确保 preventDefault 生效，
  // 避免 Chrome 默认 passive 模式下的警告和操作冲突。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const sf = e.deltaY > 0 ? 0.9 : 1.1;
      setView((prev) => {
        const ns = Math.max(0.2, Math.min(3, prev.scale * sf));
        return { scale: ns, tx: mx - (mx - prev.tx) * (ns / prev.scale), ty: my - (my - prev.ty) * (ns / prev.scale) };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const zoomIn  = () => { const el = canvasRef.current; if (!el) return; const ns = Math.min(3, view.scale * 1.2); const r = el.getBoundingClientRect(); setView(v => ({ ...v, scale: ns, tx: r.width / 2 - (r.width / 2 - v.tx) * (ns / v.scale), ty: r.height / 2 - (r.height / 2 - v.ty) * (ns / v.scale) })); };
  const zoomOut = () => { const el = canvasRef.current; if (!el) return; const ns = Math.max(0.2, view.scale / 1.2); const r = el.getBoundingClientRect(); setView(v => ({ ...v, scale: ns, tx: r.width / 2 - (r.width / 2 - v.tx) * (ns / v.scale), ty: r.height / 2 - (r.height / 2 - v.ty) * (ns / v.scale) })); };
  const fitAll  = () => {
    const el = canvasRef.current; if (!el || !layoutNodes.length) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    const rootLn = [...layoutNodes].sort((a, b) => a.y - b.y)[0];
    if (!rootLn) return;
    const rootCx = rootLn.x + rootLn.w / 2;
    const scaleX = (cw - 80) / (canvasW || 400);
    const scaleY = (ch - 80) / (canvasH || 300);
    const ns = Math.min(scaleX, scaleY, 1.5);
    setView({ scale: ns, tx: cw / 2 - rootCx * ns, ty: 24 });
  };

  return (
    <div
      ref={canvasRef}
      className={`${styles.canvas} ${panning ? styles.canvasDragging : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onContextMenu={handleCanvasContextMenu}
      tabIndex={0}
    >
      {/* 变换层 */}
      <div
        className={styles.transformLayer}
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {/* 空状态：无节点时显示提示 */}
        {layoutNodes.length === 0 && (
          <div className={styles.emptyState}>
            <span className={styles.emptyStateIcon}>🌳</span>
            <span className={styles.emptyStateText}>对话树为空</span>
            <span className={styles.emptyStateHint}>发送消息后将在此展示对话结构</span>
          </div>
        )}

        {/* MCP 轮次分组背景（点击标签切换整轮折叠） */}
        {roundGroups.map(rg => {
          const isRoundCollapsed = collapsedRounds.has(rg.roundIndex);
          return (
            <div
              key={`rg-${rg.roundIndex}`}
              className={`${styles.roundGroupBg} ${rg.position === 'end' ? styles.roundGroupEnd : ''} ${isRoundCollapsed ? styles.roundGroupCollapsed : ''}`}
              style={{ left: rg.x, top: rg.y, width: rg.w, height: rg.h }}
            >
              <span
                className={styles.roundGroupLabel}
                onClick={(e) => toggleRoundCollapse(rg.roundIndex, e)}
                title={isRoundCollapsed ? '展开此轮' : '折叠此轮'}
              >
                {isRoundCollapsed ? '▸ ' : '▾ '}{rg.label}
              </span>
            </div>
          );
        })}

        {/* SVG 连线 */}
        <svg
          className={styles.edgeLayer}
          style={{ width: Math.max(canvasW + 200, 600), height: Math.max(canvasH + 200, 600) }}
        >
          {edges.map((e, i) => (
            <line
              key={i}
              className={`${styles.edgeLine} ${e.isBranch ? styles.edgeLineBranch : ''}`}
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            />
          ))}
        </svg>

        {/* 节点 */}
        {layoutNodes.map(ln => {
          const tn = ln.treeNode;
          // 防御：跳过无 TreeNode 的布局节点
          if (!tn) return null;
          const isToolResult = tn.type === 'tool-result';
          const isToolCall   = tn.type === 'tool-call';
          const isAssistant  = tn.type === 'assistant';
          const isCompact = tn.compact === true;
          const phaseClass = isAssistant && tn.assistantPhase
            ? styles[`node_assistant_${tn.assistantPhase}` as keyof typeof styles]
            : '';
          const nodeLabelClass = [
            styles.treeNode,
            styles[`node_${tn.type}`],
            phaseClass,
            tn.isCurrent ? styles.current : '',
            tn.isStreaming ? styles.streaming : '',
            tn.isInactive ? styles.inactiveBranch : '',
            (isToolCall && tn.isError) ? styles.toolCallError : '',
            (isToolResult && tn.isError) ? styles.toolResultError : '',
            isCompact ? styles.compactNode : '',
            (tn.messageId && selectedNodeIds.has(tn.messageId)) ? styles.selected : '',
          ].filter(Boolean).join(' ');
          return (
            <div
              key={ln.id}
              data-node-id={ln.id}
              className={nodeLabelClass}
              style={{ left: ln.x, top: ln.y, width: ln.w, height: ln.h }}
              onContextMenu={(e) => {
                const msgId = tn.messageId;
                if (msgId && messageTree[msgId]) {
                  handleNodeContextMenu(e, msgId, messageTree[msgId].role);
                }
              }}
              onClick={(e) => {
                // Ctrl/Cmd + 点击 → 切换多选
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  if (!tn.messageId) return;
                  setSelectedNodeIds(prev => {
                    const next = new Set(prev);
                    if (next.has(tn.messageId!)) next.delete(tn.messageId!);
                    else next.add(tn.messageId!);
                    return next;
                  });
                  return;
                }
                // 轮次汇总节点（label 以 "MCP 轮 #" 开头）→ 切换整轮折叠
                if (isCompact && tn.label.startsWith('MCP 轮 #') && tn.roundIndex !== undefined) {
                  toggleRoundCollapse(tn.roundIndex);
                  return;
                }
                // 普通紧凑摘要条 → 展开单节
                if (isCompact) {
                  toggleCollapse(tn.id);
                  return;
                }
                if (tn.messageId) {
                  // 导航前清除多选
                  clearSelection();
                  onNavigate(tn.messageId);
                }
              }}
              title={
                isCompact && tn.label.startsWith('MCP 轮 #')
                  ? '点击展开/折叠整轮'
                  : isCompact
                    ? '点击展开此轮工具调用详情'
                    : (tn.messageId ? `${tn.label}${tn.sublabel ? `\n${tn.sublabel}` : ''}\n— 点击回到对话中此消息的位置\nCtrl+点击多选，左键拖拽框选，右键拖拽平移` : undefined)
              }
            >
              <span className={styles.nodeIcon}>
                {isToolResult ? (tn.isError ? '✕' : '✓') : isToolCall ? (tn.isError ? '⚠' : '⚙') : ri(tn.type)}
              </span>
              <div className={styles.nodeBody}>
                <div className={`${styles.nodeLabel} ${isCompact ? styles.compactLabel : ''}`}>
                  {isToolCall ? tn.label : tn.label}
                </div>
                {/* 所有节点类型都显示 sublabel（工具节点显示结果摘要） */}
                {tn.sublabel && (
                  <div className={`${styles.nodeSublabel} ${isCompact ? styles.compactSublabel : ''}`}>{tn.sublabel}</div>
                )}
              </div>
              {/* 折叠/展开按钮 */}
              {isCompact && tn.label.startsWith('MCP 轮 #') && tn.roundIndex !== undefined ? (
                // 轮次汇总节点 → 切换整轮折叠
                <button
                  className={styles.collapseToggle}
                  onClick={(e) => toggleRoundCollapse(tn.roundIndex, e)}
                  title="展开/折叠整轮"
                >
                  ▸
                </button>
              ) : (isCompact || (isAssistant && tn.children.length > 0)) ? (
                // 单节摘要或已展开助理 → 切换单节折叠
                <button
                  className={styles.collapseToggle}
                  onClick={(e) => toggleCollapse(tn.id, e)}
                  title={isCompact ? '展开此节' : '折叠此节'}
                >
                  {isCompact ? '▸' : '▾'}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 框选矩形（画布容器坐标，不在 transform 层内） */}
      {boxRect && (
        <div
          className={styles.selectionBox}
          style={{ left: boxRect.x, top: boxRect.y, width: boxRect.w, height: boxRect.h }}
        />
      )}

      {/* 底部工具栏 */}
      <div className={styles.toolbar}>
        {/* 选中计数（多选时显示） */}
        {selectedNodeIds.size > 1 && (
          <>
            <span className={styles.toolbarSummary}>
              <span title="已选中节点数">☑ {selectedNodeIds.size} 个</span>
            </span>
            <button
              className={styles.toolbarBtn}
              onClick={clearSelection}
              title="取消选中 (Esc)"
              style={{ fontSize: '0.7rem', width: 'auto', padding: '0 8px' }}
            >
              取消
            </button>
            <span className={styles.toolbarDivider} />
          </>
        )}
        {/* 对话统计摘要 */}
        <div className={styles.toolbarSummary}>
          <span title="消息总数">{allMessages.length} 条消息</span>
          {roundGroups.length > 0 && (
            <span title="MCP 工具调用轮次">{roundGroups.length} 轮 MCP</span>
          )}
          {layoutNodes.filter(n => n.treeNode?.type === 'tool-call').length > 0 && (
            <span title="工具调用次数">
              ⚙ {layoutNodes.filter(n => n.treeNode?.type === 'tool-call').length} 次
            </span>
          )}
        </div>
        {/* 图例：流式期间解释蓝色外发光 vs 绿色左边框 */}
        {isStreaming && (
          <div className={styles.toolbarSummary} style={{ gap: 6 }}>
            <span title="蓝色外发光 = 正在查看的分支" style={{ color: '#3b82f6' }}>◉ 查看</span>
            <span title="绿色左边框 = 正在生成的分支" style={{ color: '#22c55e' }}>◧ 生成</span>
          </div>
        )}
        <span className={styles.toolbarDivider} />
        <button className={styles.toolbarBtn} onClick={zoomOut} title="缩小" disabled={view.scale <= 0.25}>−</button>
        <span className={styles.toolbarZoom}>{Math.round(view.scale * 100)}%</span>
        <button className={styles.toolbarBtn} onClick={zoomIn} title="放大" disabled={view.scale >= 3}>+</button>
        <span className={styles.toolbarDivider} />
        <button className={styles.toolbarBtn} onClick={fitAll} title="适应屏幕">⊡</button>
        <span className={styles.toolbarDivider} />
        <button className={styles.toolbarBtn} onClick={onClose} title="返回对话">✕</button>
      </div>

      {/* 右键上下文菜单 */}
      {contextMenu && (
        <div
          className={styles.contextMenu}
          data-context-menu
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* ── 多选模式：仅显示删除 ── */}
          {contextMenu.isMultiSelect ? (
            <>
              <div className={styles.contextMenuMultiHint}>
                已选 {contextMenu.selectedIds.length} 个节点
              </div>
              {/* 分支切换暂不支持多选 */}
              {onDeleteMultiple && (
                <button
                  className={`${styles.contextMenuBtn} ${styles.contextMenuBtnDanger}`}
                  onClick={() => { onDeleteMultiple(contextMenu.selectedIds); closeContextMenu(); }}
                  title={`删除 ${contextMenu.selectedIds.length} 个节点`}
                >
                  <DeleteIcon size={14} /> 删除 ({contextMenu.selectedIds.length})
                </button>
              )}
            </>
          ) : (
            <>
              {/* ── 单选模式：全部功能 ── */}
              {/* 分支切换指示器（如果有多个分支） */}
              {contextMenu.hasMultiBranch && currentSessionId && onBranchSwitch && (() => {
                const state = useChatStore.getState();
                const session = state.sessions[currentSessionId];
                const leafId = session?.viewLeafId;
                const brLeaves = getDirectBranchLeaves(session?.messageTree ?? {}, contextMenu.messageId, leafId);
                if (brLeaves.length > 1) {
                  const currentIdx = leafId ? brLeaves.indexOf(leafId) : -1;
                  return (
                    <button
                      className={`${styles.contextMenuBtn} ${styles.contextMenuBranch}`}
                      onClick={() => {
                        const nextIdx = (currentIdx + 1) % brLeaves.length;
                        onBranchSwitch(currentSessionId, brLeaves[nextIdx]);
                        closeContextMenu();
                      }}
                      title="切换分支"
                    >
                      ● {currentIdx + 1}/{brLeaves.length}
                    </button>
                  );
                }
                return null;
              })()}
              {onEdit && contextMenu.role !== 'tool' && contextMenu.role !== 'system' && (
                <button
                  className={styles.contextMenuBtn}
                  onClick={() => { onEdit(contextMenu.messageId); closeContextMenu(); }}
                  title="编辑"
                >
                  <EditIcon size={14} /> 编辑
                </button>
              )}
              {onRetry && contextMenu.role !== 'tool' && contextMenu.role !== 'system' && (
                <button
                  className={styles.contextMenuBtn}
                  onClick={() => { onRetry(contextMenu.messageId); closeContextMenu(); }}
                  title="重试"
                >
                  <RetryIcon size={14} /> 重试
                </button>
              )}
              {onCopy && (
                <button
                  className={styles.contextMenuBtn}
                  onClick={() => { onCopy(contextMenu.messageId); closeContextMenu(); }}
                  title="复制"
                >
                  <CopyIcon size={14} /> 复制
                </button>
              )}
              {onContinueFrom && contextMenu.role !== 'tool' && contextMenu.role !== 'system' && (
                <button
                  className={styles.contextMenuBtn}
                  onClick={() => { onContinueFrom(contextMenu.messageId); closeContextMenu(); }}
                  title="继续"
                >
                  <ContinueIcon size={14} /> 继续
                </button>
              )}
              {onDelete && contextMenu.messageId !== rootMessageId && (
                <button
                  className={`${styles.contextMenuBtn} ${styles.contextMenuBtnDanger}`}
                  onClick={() => { onDelete(contextMenu.messageId); closeContextMenu(); }}
                  title="删除"
                >
                  <DeleteIcon size={14} /> 删除
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
