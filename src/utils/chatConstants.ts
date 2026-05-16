// ============================================================
// chatConstants — 聊天界面共享常量
// 避免各子组件各自重复定义
// ============================================================

import type { Message } from '../types';

/** 角色 ID → 界面显示标签 */
export const ROLE_LABELS: Record<Message['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具',
};

/** 工具结果折叠阈值（字符数），超过此值默认折叠 */
export const TOOL_RESULT_COLLAPSE_LIMIT = 800;
