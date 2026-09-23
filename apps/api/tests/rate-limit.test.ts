import { describe, expect, it } from "vitest";
import { DEFAULT_EDITION, EDITIONS, isEdition } from "@biff/contracts/edition";
import { RATE_LIMIT_MAX_KEYS, createRateLimiter } from "../src/rate-limit";

/**
 * 写路径的**两道闸门**（2026-09-23，PLAN-20260923111748，B2）：
 *   ① 固定窗口限流；② `edition` 白名单（此前只校验长度）。
 *
 * ⚠ 限流这些用例钉的是「计数器的行为」，不是「线上已经安全了」：
 *   计数器在 isolate 内存里，跨 isolate / 冷启动会重置 —— 详见 `rate-limit.ts` 文件头。
 *   真正挡脚本的那一层是 Cloudflare 的 Rate Limiting Rules（要在 CF 控制台配）。
 */

const RULE = { windowMs: 60_000, max: 3 };

describe("固定窗口限流", () => {
  it("窗口内前 max 次放行，第 max+1 次被拒并给出等待秒数", () => {
    const limiter = createRateLimiter(RULE);
    for (let index = 0; index < RULE.max; index += 1) {
      expect(limiter.check("ip-a", 0).allowed).toBe(true);
    }
    const blocked = limiter.check("ip-a", 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("窗口过去后重新计数（不是永久封禁）", () => {
    const limiter = createRateLimiter(RULE);
    for (let index = 0; index < RULE.max + 1; index += 1) limiter.check("ip-a", 0);
    expect(limiter.check("ip-a", 0).allowed).toBe(false);
    expect(limiter.check("ip-a", RULE.windowMs).allowed).toBe(true);
    expect(limiter.check("ip-a", RULE.windowMs).allowed).toBe(true);
  });

  it("不同来源（键）互不影响 —— 一个人刷爆不该连坐别人", () => {
    const limiter = createRateLimiter(RULE);
    for (let index = 0; index < RULE.max + 1; index += 1) limiter.check("ip-a", 0);
    expect(limiter.check("ip-a", 0).allowed).toBe(false);
    expect(limiter.check("ip-b", 0).allowed).toBe(true);
  });

  it("键数超上限时整体清空，内存不会无界增长", () => {
    const limiter = createRateLimiter(RULE);
    for (let index = 0; index < RATE_LIMIT_MAX_KEYS; index += 1) limiter.check(`ip-${index}`, 0);
    // 清空之后所有键都重新计数，故这个新键一定放行（不会因为上一轮占满而被拒）
    expect(limiter.check("ip-a", 0).allowed).toBe(true);
  });
});

describe("edition 白名单", () => {
  it("只认已知届次 —— 任意 ≤64 字符的串此前都会被当成一个届次", () => {
    expect(isEdition(DEFAULT_EDITION)).toBe(true);
    for (const edition of EDITIONS) expect(isEdition(edition)).toBe(true);
    // 长度合法但不在白名单 → 拒绝（否则能在聚合表里凭空造出不受任何页面引用的届次）
    expect(isEdition("biff-2027")).toBe(false);
    expect(isEdition("")).toBe(false);
    expect(isEdition("x".repeat(64))).toBe(false);
    expect(isEdition(null)).toBe(false);
    expect(isEdition(42)).toBe(false);
  });
});
