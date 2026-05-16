// ============================================================
// 工具调用一致性修复（Reconciliation）工具
//
// 职责：
//   当 assistant 消息中的 tool_calls 与后续 tool 消息的
//   toolResult（通过 toolCallId 关联）不匹配时，插入特殊的
//   修复工具调用以恢复对应关系，确保导出的对话记录符合 API
//   规范（tool_calls 与 tool 消息一一对应）。
//
// 匹配失败的场景：
//   1. 多对少（extra）：assistant 中的某些 tool_call 在后续
//      tool 消息中找不到对应的 toolResult（如网络中断）
//   2. 少对多（missing）：tool 消息中有 toolCallId 在 assistant
//      的 tool_calls 中找不到（如流式防抖跨轮残留）
//   3. 交叉错位：ID 数量对但内容不匹配（极罕见）
//
// 修复策略：
//   对于上述每种场景，在 assistant 消息的 toolCalls 数组中插入
//   一个命名约定的特殊工具调用（_reconcile_tool_call_id），其
//   toolCallId 与后续插入的 tool 消息一一对应，并在 arguments
//   中描述异常详情。
// ============================================================

import type { Message, ToolCall } from '../types';
import {
  RECONCILE_TOOL_NAME,
  createReconcileToolCall,
} from '../types';

/**
 * 检查 assistant 消息的 tool_calls 与后续 tool 消息是否一一对应
 *
 * @returns 匹配分析结果
 */
export function analyzeToolCallMismatches(
  assistantMsg: Message,
  followingToolMessages: Message[]
): {
  /** assistant 中有但 tool 结果中缺失的 tool_call ID 列表 */
  missingToolResultIds: string[];
  /** tool 结果中有但 assistant 中不存在的 tool_call ID 列表 */
  orphanToolResultIds: string[];
  /** 正常的（一边 ID 匹配完全一致）是否整体正常 */
  isConsistent: boolean;
} {
  if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
    return { missingToolResultIds: [], orphanToolResultIds: [], isConsistent: true };
  }

  // 提取 tool 消息中所有 tool_call_id
  const toolResultIds = new Set(
    followingToolMessages
      .filter((m) => m.role === 'tool' && m.toolResult)
      .map((m) => m.toolResult!.toolCallId)
  );

  // 提取 assistant 中所有 tool_call id
  const assistantToolCallIds = new Set(
    assistantMsg.toolCalls.map((tc) => tc.id)
  );

  const missingToolResultIds = assistantMsg.toolCalls
    .filter((tc) => !toolResultIds.has(tc.id))
    .map((tc) => tc.id);

  const orphanToolResultIds = [...toolResultIds].filter(
    (id) => !assistantToolCallIds.has(id)
  );

  return {
    missingToolResultIds,
    orphanToolResultIds,
    isConsistent: missingToolResultIds.length === 0 && orphanToolResultIds.length === 0,
  };
}

/**
 * 对单条 assistant 消息及其后续 tool 消息执行修复
 *
 * 修复策略（按优先级）：
 *   1. 对于 missingToolResultIds（assistant 中有但没对应 tool result）：
 *      为每个缺失的 tool_call 插入一条 tool 结果消息（标记为错误），
 *      说明该工具调用没有收到结果。
 *   2. 对于 orphanToolResultIds（tool 结果中有但 assistant 没对应的 tool_call）：
 *      在 assistant 消息中插入一条特殊的 _reconcile_tool_call_id，
 *      其 ID 匹配该 orphan 结果。
 *   3. 如果 assistant 完全没有 tool_calls 但后续有 tool 消息（不匹配的起始点）：
 *      在最近的 assistant 或当前 assistant 中插入修复工具调用。
 *
 * @param messages 完整的消息列表（会被修改）
 * @param assistantIndex assistant 消息在数组中的索引
 * @returns 修改后的消息列表（新数组）
 */
export function reconcileSingleAssistant(
  messages: Message[],
  assistantIndex: number
): Message[] {
  const result = [...messages];
  const assistantMsg = result[assistantIndex];

  if (!assistantMsg || assistantMsg.role !== 'assistant') return result;

  const followingTools: Message[] = [];
  let nextNonToolIdx = assistantIndex + 1;
  while (
    nextNonToolIdx < result.length &&
    result[nextNonToolIdx].role === 'tool'
  ) {
    followingTools.push(result[nextNonToolIdx]);
    nextNonToolIdx++;
  }

  const analysis = analyzeToolCallMismatches(assistantMsg, followingTools);

  // ⚠️ 特殊场景：assistant 消息根本没有 toolCalls，但后续有 tool 消息
  // 这通常意味着 toolCalls 字段丢失（数据损坏或旧版本遗留数据）
  if (
    (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) &&
    followingTools.length > 0
  ) {
    // 为每个孤立的 tool 结果，在 assistant 中插入修复工具调用
    const fixedToolCalls: ToolCall[] = [];
    const fixedTools: Message[] = [];

    for (const toolMsg of followingTools) {
      const tr = toolMsg.toolResult;
      if (!tr) continue;

      // 用 orphan 工具结果的原有 ID 创建修复工具调用
      const reconcileTc = createReconcileToolCall(
        `[一致性修复] assistant 消息缺少 tool_calls 字段，` +
        `但后续存在 tool 结果（toolCallId: ${tr.toolCallId}，工具: ${tr.name}）。` +
        `已自动补充修复记录以维持对应关系。`,
        tr.toolCallId
      );

      // 保留原有的 tool_result，但标记其 toolCallId 已被修复
      fixedToolCalls.push(reconcileTc);
      fixedTools.push(toolMsg);
    }

    if (fixedToolCalls.length > 0) {
      result[assistantIndex] = {
        ...assistantMsg,
        toolCalls: fixedToolCalls,
      };
    }
    return result;
  }

  if (analysis.isConsistent) return result;

  // ── 1. 修复 missingToolResultIds ──────────────────────────
  // 为每个缺失的 tool_call 插入一条 tool 错误结果消息
  if (analysis.missingToolResultIds.length > 0) {
    // 🔧 新插入的 tool 消息使用 assistant 的 id 作为 parentId，
    // 确保它们在 messageTree 中作为 assistant 的子节点被正确遍历。
    // （原有的 tool 消息在 store.addMessage 时 parentId 已设为 assistantMsg.id）
    const parentForMissing = assistantMsg.id;

    const insertedToolMessages: Message[] = analysis.missingToolResultIds.map(
      (missingId) => {
        // 找到对应的 tool_call 定义
        const tc = assistantMsg.toolCalls!.find((c) => c.id === missingId);
        return {
          id: crypto.randomUUID(),
          parentId: parentForMissing,
          role: 'tool' as const,
          content: JSON.stringify({
            status: 'reconciled',
            message:
              `[系统自动修复] 工具调用 "${tc?.name ?? 'unknown'}" ` +
              `(ID: ${missingId}) 在执行过程中因网络中断或系统错误` +
              `未收到返回结果，已由一致性修复机制标记为缺失。`,
          }),
          timestamp: Date.now(),
          toolResult: {
            toolCallId: missingId,
            // 🔧 统一用 _reconcile_tool_call_id 作为 name，这样 UI 端的
            //    ToolResultBlock 只需检查 name 即可识别，无需扫描 content
            name: '_reconcile_tool_call_id',
            result: JSON.stringify({
              status: 'reconciled',
              message:
                `[系统自动修复] 工具调用 "${tc?.name ?? 'unknown'}" ` +
                `(ID: ${missingId}) 未收到返回结果。`,
            }),
            isError: true,
          },
        } as Message;
      }
    );

    // 在原有的 tool 消息之后插入（维持位置关系）
    result.splice(nextNonToolIdx, 0, ...insertedToolMessages);
    nextNonToolIdx += insertedToolMessages.length;
  }

  // ── 2. 修复 orphanToolResultIds ───────────────────────────
  // 在 assistant 的 toolCalls 中插入修复工具调用
  if (analysis.orphanToolResultIds.length > 0) {
    const fixedToolCalls = [...(assistantMsg.toolCalls ?? [])];

    for (const orphanId of analysis.orphanToolResultIds) {
      // 找到对应的 tool 结果消息
      const orphanToolMsg = result
        .slice(assistantIndex + 1)
        .find(
          (m) =>
            m.role === 'tool' &&
            m.toolResult &&
            m.toolResult.toolCallId === orphanId
        );
      const orphanToolResult = orphanToolMsg?.toolResult;

      const reconcileTc = createReconcileToolCall(
        `[一致性修复] 存在孤立的工具结果消息（toolCallId: ${orphanId}` +
        `${orphanToolResult ? `，工具: ${orphanToolResult.name}` : ''}），` +
        `但在 assistant 消息的 tool_calls 中找不到对应的原始调用。` +
        `已自动补充修复记录以维持对应关系。`,
        orphanId
      );

      fixedToolCalls.push(reconcileTc);
    }

    result[assistantIndex] = {
      ...assistantMsg,
      toolCalls: fixedToolCalls,
    };
  }

  return result;
}

/**
 * 对整个消息列表进行全面的工具调用一致性修复
 *
 * 遍历消息列表，找出所有 assistant 消息及其后续 tool 消息，
 * 对每一组执行一致性检查和修复。
 *
 * @param messages 原始消息列表（不会被修改）
 * @returns 修复后的消息列表（新数组）
 */
export function reconcileToolCalls(messages: Message[]): Message[] {
  let result = [...messages];
  let i = 0;

  // ── 预扫描：处理在 assistant 之前出现的孤儿 tool 消息 ──
  // 由于 addMessage 的 parentId 链式偏移，部分 tool 消息的 parentId
  // 指向前一条 tool 而非 assistant，导致 getActivePath 产生的线性列表中
  // tool 消息可能出现在其触发 assistant 之前。这些工具没有匹配的 toolCall，
  // 必须在发送给 API 前修复。
  for (let j = 0; j < result.length; j++) {
    if (result[j].role !== 'tool' || !result[j].toolResult) continue;

    const tcId = result[j].toolResult!.toolCallId;
    // 检查此 tool 消息之前是否有 assistant 的 toolCalls 包含此 ID
    const hasPrecedingAssistant = result.slice(0, j).some(
      m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === tcId)
    );
    if (hasPrecedingAssistant) continue;

    // 孤儿工具：找它前面最近的 assistant（任意）注入修复
    for (let k = j - 1; k >= 0; k--) {
      if (result[k].role === 'assistant') {
        const assistant = result[k];
        const existingTCs = assistant.toolCalls ?? [];
        // 不要重复注入
        if (existingTCs.some(tc => tc.id === tcId)) break;
        const reconcileTc = createReconcileToolCall(
          `[一致性修复] 工具调用 "${result[j].toolResult!.name}" ` +
          `(ID: ${tcId}) 在消息列表中的位置早于其触发 assistant，` +
          `已自动补充修复记录以维持对应关系。`,
          tcId
        );
        result[k] = {
          ...assistant,
          toolCalls: [...existingTCs, reconcileTc],
        };
        break;
      }
    }
  }

  while (i < result.length) {
    const msg = result[i];
    if (msg.role === 'assistant') {
      const newResult = reconcileSingleAssistant(result, i);
      result = newResult;
      // 重新调整 i 的位置（可能插入了新消息）
      // 跳到当前 assistant 之后的所有 tool 消息之后
      i++;
      while (i < result.length && result[i].role === 'tool') {
        i++;
      }
    } else {
      i++;
    }
  }

  return result;
}

/**
 * 检查 tool 消息是否有多余的 _reconcile_tool_call_id 工具结果，
 * 如果有且对应的 assistant 消息中的工具调用也存在，说明修复已完成，
 * 此时不需要再额外处理。
 *
 * 此函数用于判断是否需要运行完整的 reconciliation 流程。
 *
 * @param messages 消息列表
 * @returns true = 需要修复，false = 已修复或无需修复
 */
export function needsReconciliation(messages: Message[]): boolean {
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === 'assistant') {
      const assistantMsg = messages[i];
      const followingTools: Message[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        followingTools.push(messages[j]);
        j++;
      }

      if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
        const analysis = analyzeToolCallMismatches(assistantMsg, followingTools);
        if (!analysis.isConsistent) return true;
      }

      // 特殊情况：assistant 没有 toolCalls 但有 tool 消息
      if (
        (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) &&
        followingTools.length > 0
      ) {
        return true;
      }

      i = j;
    } else {
      i++;
    }
  }

  return false;
}
