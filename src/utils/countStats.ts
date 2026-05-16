// ============================================================
// countStats — 文本词数/token 统计工具
// 用于消息底部统计和会话总览统计
// ============================================================

/**
 * 统计文本的词数和估算 token 数
 * - 英文：按空白分词，~1.3 token/词
 * - CJK（中/日/韩）：每字计 1 词，~0.6 token/字
 */
export function countStats(text: string): { words: number; tokens: number } {
  if (!text.trim()) return { words: 0, tokens: 0 };
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uff00-\uffef]/g;
  const cjkCount = (text.match(cjkPattern) || []).length;
  const nonCjkWords = text.replace(cjkPattern, ' ').trim().split(/\s+/).filter((w) => w.length > 0).length;
  return {
    words: cjkCount + nonCjkWords,
    tokens: Math.round(nonCjkWords * 1.3 + cjkCount * 0.6),
  };
}
