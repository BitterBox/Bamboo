// ============================================================
// scrollCache — 滚动位置缓存（模块级，不序列化，仅进程内存）
//
// 从 useScrollNavigation.ts 中提取，供 chatStore 和 useScrollNavigation
// 共同引用。避免 chatStore（数据层）反向依赖 useScrollNavigation（UI 层）。
//
// 滚动位置 key 生成规则：
//   - 会话级别：sessionId
//   - 分支级别：sessionId + '::branch::' + viewLeafId
// ============================================================

/** 会话/分支 → 滚动位置（像素） */
export const savedScrollTops = new Map<string, number>();

/**
 * 清理指定会话的所有滚动缓存。
 * 当会话被删除时调用，防止 savedScrollTops 无限增长。
 *
 * @param sessionId 要清理的会话 ID
 */
export function clearScrollCache(sessionId: string): void {
  savedScrollTops.delete(sessionId);
  // 清理所有分支级 key（格式: sessionId::branch::leafId）
  for (const key of savedScrollTops.keys()) {
    if (key.startsWith(sessionId + '::branch::')) {
      savedScrollTops.delete(key);
    }
  }
}

/**
 * 清理所有滚动缓存（应用卸载时调用）。
 */
export function clearAllScrollCache(): void {
  savedScrollTops.clear();
}
