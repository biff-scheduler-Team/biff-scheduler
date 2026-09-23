/**
 * 写端点的**第一道闸门**（2026-09-23，PLAN-20260923111748，B2）。
 *
 * ★ 边界必须写清楚（否则会被误当成「已经限流了」）：
 *   这里是 isolate 内存里的固定窗口计数器 —— **没有**新增 KV / Durable Object 绑定
 *   （那属 `wrangler.jsonc` 变更，要先与用户确认）。所以它只保证
 *   「同一 isolate 内、同一来源 IP 短时间内不能零成本猛刷」；
 *   跨 isolate 命中、或冷启动之后，计数会重置。
 *   它能挡住最廉价的滥用（一个脚本对着一个连接反复灌统计 / 打第三方配额），
 *   **但不能替代 Cloudflare 的 Rate Limiting Rules / WAF** —— 那一层要在 CF 控制台配置，
 *   仓库里配不了。此文件的职责是「在没有 CF 规则时也不至于零成本被刷」，并把这条缺口显式留痕。
 *
 * 为什么值得加：此前**一个限流都没有**，唯一防线是 `Origin` 头校验（`index.ts:142`），
 * 而那是客户端可控的请求头 —— curl 随手就能填对。有了这一层，刷榜至少要跨 isolate。
 *
 * 纯逻辑（`check` 的 `now` 可注入），故 node 环境可测。
 */

/** 固定窗口规则。 */
export interface RateLimitRule {
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口内允许的最大次数。 */
  max: number;
}

/** 内存里最多保留多少个来源桶；超过就整体清空（条目少、清空成本低，比实现 LRU 划算）。 */
export const RATE_LIMIT_MAX_KEYS = 10_000;

export interface RateLimitDecision {
  allowed: boolean;
  /** 被拒时建议的等待秒数（回给 `Retry-After`）。 */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** 记一次访问并判定是否放行（`now` 可注入，便于单测把时间钉住）。 */
  check(key: string, now?: number): RateLimitDecision;
  /** 清空全部计数（单测用）。 */
  reset(): void;
}

export function createRateLimiter(rule: RateLimitRule): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string, now: number = Date.now()): RateLimitDecision {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        if (buckets.size >= RATE_LIMIT_MAX_KEYS) buckets.clear();
        buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      bucket.count += 1;
      if (bucket.count > rule.max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/** 五个统计 ping + 地点查询的额度：给真人留足冗余（每次改动只上报一次），只挡脚本。 */
export const PING_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, max: 60 };
/** 地点查询会打第三方日配额（Naver 25k / Kakao 100k），故单独收紧。 */
export const LOOKUP_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, max: 30 };
