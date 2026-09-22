import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateStorage } from "../src/app/store";
import { rankOf } from "../src/state";
import { catalog, show } from "./helpers";

const cat = catalog([show({ code: "001" }), show({ code: "002" })]);
const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  values.set("biff.picks.v2", JSON.stringify([
    { key: "one", picks: [{ code: "001" }, { code: "002" }], note: "" },
  ]));
});

afterEach(() => vi.unstubAllGlobals());

describe("legacy storage hydration order", () => {
  it("prunes ranks outside the loaded picks while preserving selected ranks and unknown keys", () => {
    values.set("biff.ranks.v1", '{"001":2,"002":1,"removed":3}');
    values.set("biff.future.v9", '{ "unchanged": true }');
    hydrateStorage(cat);
    expect(Object.fromEntries(rankOf)).toEqual({ "001": 2, "002": 1 });
    expect(JSON.parse(values.get("biff.ranks.v1")!)).toEqual({ "001": 2, "002": 1 });
    expect(values.get("biff.future.v9")).toBe('{ "unchanged": true }');
  });

  it("keeps valid rank bytes, and leaves the retired savedplans key byte-for-byte", () => {
    const ranks = '{ "001": 2, "002": 1 }';
    // 「已保存方案」已整体下线(2026-09-22,`PLAN-20260922105228`):这个键**不再被读**,
    // 但必须**原样留着** —— 数据契约只增不改,备份前缀快照与 `compatibility.spec.ts` 的字节级断言
    // 都依赖「加载旧数据不丢键」。哪天误把它读出来再写回去(或删掉),这条会红。
    const plans = '[{"id":"saved","name":"方案 1","codes":["001"],"createdAt":1}]';
    values.set("biff.ranks.v1", ranks);
    values.set("biff.savedplans.v1", plans);
    hydrateStorage(cat);
    hydrateStorage(cat);
    expect(values.get("biff.ranks.v1")).toBe(ranks);
    expect(values.get("biff.savedplans.v1")).toBe(plans);
  });
});
