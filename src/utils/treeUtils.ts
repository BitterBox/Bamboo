// ============================================================
// treeUtils — 消息树工具函数
// 提供从 messageTree（ parentId 树结构）中获取路径、子树操作等工具
// 包含 BranchPath 轻量路径类型及比较/查找/归属判断
//
// 后续扩展：并发流时，每个分支独立流式，这些工具函数依然适用
// ============================================================

import type { Message, Session } from '../types';

// ── 分支路径类型 ──────────────────────────────────────────

/** 分支路径：从根到某个叶子的消息 ID 序列（根在前，叶子在后） */
export type BranchPath = string[];

/**
 * 从指定叶子消息回溯到根，获得线性消息列表（根在前，叶子在后）。
 * 如果 leafId 为 null，返回空数组。
 * 如果路径中的某条消息在 messageTree 中不存在，终止并返回已收集的部分。
 */
export function getPathToRoot(
  messageTree: Record<string, Message>,
  leafId: string | null,
): Message[] {
  if (!leafId) return [];

  const path: Message[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const msg = messageTree[currentId];
    if (!msg) break; // 防御：消息不存在，终止
    path.unshift(msg);
    currentId = msg.parentId;
  }

  return path;
}

// ── BranchPath 工具函数 ───────────────────────────────────

/**
 * 从 leafId 回溯构建 BranchPath（纯 ID 序列，轻量）。
 * 等价于 getPathToRoot(...).map(m => m.id)，但跳过 Message 对象构造。
 */
export function getBranchPath(
  messageTree: Record<string, Message>,
  leafId: string | null,
): BranchPath {
  if (!leafId) return [];

  const ids: string[] = [];
  const visited = new Set<string>();
  let cur: string | null = leafId;

  while (cur && !visited.has(cur)) {
    visited.add(cur);
    ids.unshift(cur);
    cur = messageTree[cur]?.parentId ?? null;
  }

  return ids;
}

/** 获取当前执行分支的 BranchPath */
export function getExecPath(session: Session): BranchPath {
  return getBranchPath(session.messageTree, session.execLeafId);
}

/** 获取当前视图分支的 BranchPath */
export function getViewPath(session: Session): BranchPath {
  return getBranchPath(session.messageTree, session.viewLeafId);
}

/** 两条路径是否完全相同 */
export function isSamePath(a: BranchPath, b: BranchPath): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/**
 * 两条路径的分叉点索引（第一个不同消息的位置）。
 * 返回 -1 表示完全相同；返回 0 表示根节点就不同。
 * 若一条是另一条的前缀，返回较短那条的长度。
 */
export function forkIndex(a: BranchPath, b: BranchPath): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

/** a 是否是 b 的祖先路径（a 是 b 的真前缀） */
export function isAncestorPath(a: BranchPath, b: BranchPath): boolean {
  if (a.length >= b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/**
 * 给定消息 ID，沿树向下找到它最终通向的叶子。
 * 多子节点时取时间戳最新的（启发式，适用于单分支活跃路径）。
 */
export function getLeafOf(
  messageTree: Record<string, Message>,
  messageId: string,
): string | null {
  const msg = messageTree[messageId];
  if (!msg) return null;

  const children = Object.values(messageTree).filter(m => m.parentId === messageId);
  if (children.length === 0) return messageId;

  const latest = children.sort((a, b) => b.timestamp - a.timestamp)[0];
  return getLeafOf(messageTree, latest.id);
}

/**
 * 获取当前视图分支的线性消息列表（含完整 Message 对象）。
 * 仅需要 ID 序列时请使用更轻量的 getViewPath()。
 */
export function getActivePath(session: Session): Message[] {
  return getPathToRoot(session.messageTree, session.viewLeafId);
}

/**
 * 获取某消息的所有叶子分支的叶子消息 ID 列表。
 * 遍历 messageTree，找到所有以 parentId 为祖先的叶子消息。
 * 如果 parentId 本身是叶子（没有子消息），返回空数组。
 *
 * 后续扩展：并发流时，每个叶子对应一个独立分支，可用于展示分支列表。
 */
export function getChildLeaves(
  messageTree: Record<string, Message>,
  parentId: string,
): string[] {
  const leaves: string[] = [];

  // 递归查找所有子节点中的叶子
  function collect(nodeId: string) {
    const children = Object.values(messageTree).filter(m => m.parentId === nodeId);
    if (children.length === 0) {
      leaves.push(nodeId);
    } else {
      for (const child of children) {
        collect(child.id);
      }
    }
  }

  collect(parentId);
  return leaves;
}

/**
 * 判断 nodeId 是否在 ancestorId 的子树中（包括 nodeId === ancestorId 的情况）。
 */
export function isDescendantOf(
  messageTree: Record<string, Message>,
  nodeId: string,
  ancestorId: string,
): boolean {
  let currentId: string | null = nodeId;
  while (currentId) {
    if (currentId === ancestorId) return true;
    const msg = messageTree[currentId];
    if (!msg) break;
    currentId = msg.parentId;
  }
  return false;
}

/**
 * 获取某消息的直接子节点中，每个子节点所在分支的叶子消息 ID。
 * 每条直接子分支只返回一个代表叶子（若子节点非叶子，则取其子树中的代表叶子）。
 * 用于分支切换按钮，确保只在同一层级的分支方向之间切换。
 *
 * 如果传入了 viewLeafId，会检查视图叶子是否在某个子分支的子树中，
 * 如果是，则用 viewLeafId 作为该分支的代表叶子，确保分支切换按钮始终显示当前分支位置。
 *
 * 示例 1（无 viewLeafId 或视图叶子不在任何子分支中）：
 *   A
 *   ├── B        → 返回 B（B 自身是叶子）
 *   └── C
 *       └── D    → 返回 D（C 非叶子，取其子树中的第一个叶子 D）
 *   → 返回 [B, D]，在 A 上显示 2 个分支方向
 *
 * 示例 2（viewLeafId = E，且 E 在 C→... 子树中）：
 *   A
 *   ├── B
 *   └── C
 *       ├── D
 *       └── E（活跃叶子）
 *   → 返回 [B, E]，按钮显示 "2/2"，而非隐藏
 */
export function getDirectBranchLeaves(
  messageTree: Record<string, Message>,
  parentId: string,
  viewLeafId?: string | null,
): string[] {
  const directChildren = Object.values(messageTree)
    .filter(m => m.parentId === parentId)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (directChildren.length <= 1) return [];

  const viewPath = viewLeafId ? getBranchPath(messageTree, viewLeafId) : null;

  return directChildren.map((child) => {
    // 如果传入了 viewLeafId 且它在当前子分支的子树中，直接返回 viewLeafId
    if (viewPath && viewPath.includes(child.id)) {
      return viewLeafId;
    }
    // 如果直接子节点是叶子，直接返回
    const grandchildren = Object.values(messageTree).filter(m => m.parentId === child.id);
    if (grandchildren.length === 0) return child.id;
    // 否则取该子树中的第一个叶子（DFS 优先取最早的消息）
    function firstLeaf(nodeId: string): string {
      const subs = Object.values(messageTree)
        .filter(m => m.parentId === nodeId)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (subs.length === 0) return nodeId;
      return firstLeaf(subs[0].id);
    }
    return firstLeaf(child.id);
  });
}

/**
 * 从 messageTree 中删除指定消息及其所有后代的子消息（整棵子树）。
 * 返回删除后的新 messageTree（不修改原对象）。
 */
export function removeSubtree(
  messageTree: Record<string, Message>,
  fromId: string,
): Record<string, Message> {
  const toRemove = new Set<string>();

  // 收集所有要删除的 ID（DFS）
  function collectDescendants(nodeId: string) {
    toRemove.add(nodeId);
    for (const msg of Object.values(messageTree)) {
      if (msg.parentId === nodeId) {
        collectDescendants(msg.id);
      }
    }
  }

  collectDescendants(fromId);

  const newTree: Record<string, Message> = {};
  for (const [id, msg] of Object.entries(messageTree)) {
    if (!toRemove.has(id)) {
      newTree[id] = msg;
    }
  }

  return newTree;
}

/**
 * 从 messageTree 中截断：删除指定消息及其之后的所有后代消息。
 * 保留 fromId 之前的消息，fromId 本身也保留。
 * 返回删除后的新 messageTree（不修改原对象）。
 */
export function truncateFrom(
  messageTree: Record<string, Message>,
  fromId: string,
): Record<string, Message> {
  // 收集 fromId 及其所有后代
  const toRemove = new Set<string>();

  function collectDescendants(nodeId: string) {
    toRemove.add(nodeId);
    for (const msg of Object.values(messageTree)) {
      if (msg.parentId === nodeId) {
        collectDescendants(msg.id);
      }
    }
  }

  collectDescendants(fromId);

  const newTree: Record<string, Message> = {};
  for (const [id, msg] of Object.entries(messageTree)) {
    if (!toRemove.has(id)) {
      newTree[id] = msg;
    }
  }

  return newTree;
}

/**
 * 从 messageTree 中截断：删除指定消息之后的所有消息（保留该消息本身）。
 * 通过 execLeafId 回溯找到从根到 fromId 的路径，然后删除该路径上 fromId 之后的分支。
 * 返回 { tree, newLeafId }。
 */
export function truncateAfter(
  messageTree: Record<string, Message>,
  execLeafId: string | null,
  fromId: string,
): { tree: Record<string, Message>; newLeafId: string | null } {
  // 找到从根到当前执行叶子的路径
  const path = getPathToRoot(messageTree, execLeafId);
  const fromIdx = path.findIndex(m => m.id === fromId);
  if (fromIdx === -1) return { tree: messageTree, newLeafId: execLeafId };

  // 收集路径上 fromId 之后的所有消息 ID
  const toRemove = new Set<string>();
  for (let i = fromIdx + 1; i < path.length; i++) {
    collectDescendants(messageTree, path[i].id, toRemove);
  }

  if (toRemove.size === 0) return { tree: messageTree, newLeafId: execLeafId };

  const newTree: Record<string, Message> = {};
  for (const [id, msg] of Object.entries(messageTree)) {
    if (!toRemove.has(id)) {
      newTree[id] = msg;
    }
  }

  return {
    tree: newTree,
    newLeafId: fromId, // 新的叶子就是 fromId
  };
}

function collectDescendants(
  messageTree: Record<string, Message>,
  nodeId: string,
  result: Set<string>,
) {
  result.add(nodeId);
  for (const msg of Object.values(messageTree)) {
    if (msg.parentId === nodeId) {
      collectDescendants(messageTree, msg.id, result);
    }
  }
}

/**
 * 将会话的线性消息列表（旧格式 messages: Message[]）转换为树格式。
 * 迁移用：每条消息的 parentId 按顺序指向前一条，第一条 parentId=null。
 * 返回 { messageTree, rootMessageId, execLeafId, viewLeafId }。
 */
export function migrateLinearToTree(
  messages: Message[],
): { messageTree: Record<string, Message>; rootMessageId: string | null; execLeafId: string | null; viewLeafId: string | null } {
  if (messages.length === 0) {
    return { messageTree: {}, rootMessageId: null, execLeafId: null, viewLeafId: null };
  }

  const messageTree: Record<string, Message> = {};
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    messageTree[msg.id] = {
      ...msg,
      parentId: i === 0 ? null : messages[i - 1].id,
    };
  }

  const leafId = messages[messages.length - 1].id;
  return {
    messageTree,
    rootMessageId: messages[0].id,
    execLeafId: leafId,
    viewLeafId: leafId,
  };
}

/**
 * 确保消息树有 system 根节点（parentId=null, role='system'）。
 *
 * 若已有 system 根节点 → 原样返回。
 * 若没有（老数据） → 创建 system 节点，将所有老根消息（parentId=null
 * 的非 system 消息）的 parentId 重新指向新 system 节点。
 *
 * @param messageTree  当前消息树
 * @param systemPrompt 智能体提示词（作为 system 节点的 content）
 * @param timestamp    可选时间戳，默认取最老根消息的时间或 Date.now()
 */
export function ensureSystemRootNode(
  messageTree: Record<string, Message>,
  systemPrompt: string,
  timestamp?: number,
): { messageTree: Record<string, Message>; rootMessageId: string } {
  // 已有 system 根节点 → 不需要迁移
  const existing = Object.values(messageTree)
    .find(m => m.parentId === null && m.role === 'system');
  if (existing) {
    return { messageTree, rootMessageId: existing.id };
  }

  // 找出所有老根消息（parentId=null 的非 system 消息）
  const oldRoots = Object.values(messageTree)
    .filter(m => m.parentId === null && m.role !== 'system');

  const fallbackTs = timestamp ?? oldRoots[0]?.timestamp ?? Date.now();

  // 创建 system 根节点
  const sysMsgId = crypto.randomUUID();
  const sysMsg: Message = {
    id: sysMsgId,
    role: 'system',
    content: systemPrompt,
    parentId: null,
    timestamp: fallbackTs,
  };

  // 重建 messageTree：老根消息的 parentId 指向 system 节点
  const newTree: Record<string, Message> = { [sysMsgId]: sysMsg };
  for (const [id, msg] of Object.entries(messageTree)) {
    if (msg.parentId === null && msg.role !== 'system') {
      newTree[id] = { ...msg, parentId: sysMsgId };
    } else {
      newTree[id] = msg;
    }
  }

  return { messageTree: newTree, rootMessageId: sysMsgId };
}
