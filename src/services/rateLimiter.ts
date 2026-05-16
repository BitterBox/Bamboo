// ============================================================
// RateLimiter — 客户端请求速率限制器（滑动窗口算法）
//
// 设计：
//   - 单例，模块级实例
//   - 滑动窗口：维护每个 key 在 60s 窗口内的请求时间戳
//   - 两层限流：服务商级 + 模型级，互不冲突
//   - 超限时排队等待，而非直接拒绝
//   - 30s 超时保护，防止永久阻塞
// ============================================================

const WINDOW_MS = 60_000; // 1 分钟滑动窗口
const MAX_WAIT_MS = 30_000; // 最多排队等待 30 秒

class RateLimiter {
  /** key → 时间戳数组（已排序，最早在前） */
  private windows = new Map<string, number[]>();

  /**
   * 申请一次请求许可。若当前窗口已满，等待直到有空位或超时。
   *
   * @param providerId  服务商 ID
   * @param modelId     模型 ID
   * @param providerRPM 服务商级每分钟限制（0 = 不限）
   * @param modelRPM    模型级每分钟限制（0 = 不限）
   * @returns           许可通过；超时则 reject
   */
  async acquire(
    providerId: string,
    modelId: string,
    providerRPM: number,
    modelRPM: number,
    onWait?: (waitMs: number) => void
  ): Promise<void> {
    const now = Date.now();

    // 构建需要检查的限制列表
    const limits: Array<{ key: string; rpm: number }> = [];
    if (providerRPM > 0) limits.push({ key: `p:${providerId}`, rpm: providerRPM });
    if (modelRPM > 0) limits.push({ key: `m:${providerId}:${modelId}`, rpm: modelRPM });

    if (limits.length === 0) return; // 无限制，直接放行

    // 第一遍：计算需要等待的最大时长
    let maxWaitMs = 0;

    for (const { key, rpm } of limits) {
      let window = this.windows.get(key) ?? [];

      // 清理过期记录（超过 60s 的时间戳）
      window = window.filter((ts) => now - ts < WINDOW_MS);

      if (window.length >= rpm) {
        // 窗口已满：最早记录过期后才能放行
        const oldest = window[0];
        const waitMs = oldest + WINDOW_MS - now + 10; // +10ms 缓冲，避免边界竞争
        if (waitMs > maxWaitMs) maxWaitMs = waitMs;
      }
    }

    // 等待
    if (maxWaitMs > 0) {
      if (maxWaitMs > MAX_WAIT_MS) {
        throw new Error(
          `速率限制排队超时：预计需要等待 ${Math.ceil(maxWaitMs / 1000)}s，超过最大等待时间 ${MAX_WAIT_MS / 1000}s`
        );
      }
      onWait?.(maxWaitMs);
      await new Promise((resolve) => setTimeout(resolve, maxWaitMs));
    }

    // 第二遍：在所有等待完成后，记录实际请求时间戳
    const actualTime = Date.now();
    for (const { key } of limits) {
      let window = this.windows.get(key) ?? [];
      window = window.filter((ts) => actualTime - ts < WINDOW_MS);
      window.push(actualTime);
      this.windows.set(key, window);
    }
  }
}

/** 全局单例 */
export const rateLimiter = new RateLimiter();