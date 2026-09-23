// 账号同步缓存解析的回归测试（2026-09-23，PLAN-20260923111748，B4）。
//
// 为什么必须钉住：缓存解析此前写成 `cacheSchema.parse(JSON.parse(raw))` 且调用点落在
// `initAccountSync` 的 `try` 之外 —— 一旦 localStorage 里的缓存损坏（半截写入 / 被人工改过），
// 异常会冲出整个初始化：`iffday:workspace-change` / `online` / `focus` / `storage` 监听与
// 20s 定时同步**全都挂不上**，此后任何改动都不再同步，只能手动清 localStorage 才能恢复。
//
// 纯函数，不碰 DOM（vitest environment = node）。

import { describe, expect, it } from "vitest";
import { parseStoredCache } from "../src/account-sync";

const EMPTY = { base: {}, local: {}, revision: 0, account: null, lastSyncAt: 0 };

describe("parseStoredCache", () => {
  it("★ 半截 / 损坏 JSON 降级成空缓存并把原文交回，而不是抛异常", () => {
    const half = '{"base":{"pick:cat:f001":"{';
    const { cache, corruptRaw } = parseStoredCache(half);
    expect(corruptRaw).toBe(half);
    expect(cache).toEqual(EMPTY);
  });

  it("结构可解析但字段类型不对（被人工改过）同样降级", () => {
    const { cache, corruptRaw } = parseStoredCache(JSON.stringify({ base: "not-an-object" }));
    expect(corruptRaw).not.toBeNull();
    expect(cache.base).toEqual({});
  });

  it("对照：这条原文直接 parse 是会抛的 —— 正是修复要拦住的异常", () => {
    // 旧实现是 `cacheSchema.parse(JSON.parse(raw))` 且调用点在 initAccountSync 的 try 之外，
    // 下面的 throw 会一路冲出初始化、让所有同步监听挂不上（这就是本用例存在的理由）。
    const half = '{"base":{"pick:cat:f001":"{';
    expect(() => JSON.parse(half)).toThrow();
  });

  it("首次进入（没有缓存）不算损坏", () => {
    const { cache, corruptRaw } = parseStoredCache(null);
    expect(corruptRaw).toBeNull();
    expect(cache).toEqual(EMPTY);
  });

  it("正常缓存原样返回，不丢 revision / 本地记录", () => {
    const raw = JSON.stringify({
      base: {},
      local: { "pick:cat:f001": "{}" },
      revision: 7,
      account: null,
      lastSyncAt: 5,
    });
    const { cache, corruptRaw } = parseStoredCache(raw);
    expect(corruptRaw).toBeNull();
    expect(cache.revision).toBe(7);
    expect(cache.lastSyncAt).toBe(5);
    expect(cache.local["pick:cat:f001"]).toBe("{}");
  });
});
