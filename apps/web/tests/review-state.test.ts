import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateStorage } from "../src/app/store";
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

describe("legacy storage hydration", () => {
  // 回归:`biff.ranks.v1`(抢票顺位)/ `biff.agendafold.v1`(行程按日收起)/ `biff.tickets.v1`(票务三态)
  // 三套机制的**代码**已于 2026-09-30 整体删除(`PLAN-20260930213528`),残留键必须在载入时清掉 ——
  // 留着它们,下一次「换数据源 / 从备份还原」就会把它们当成活数据复活(`biff.plan.v1` 的教训)。
  it("★ 清掉已下线机制的三只残留键,其余键原样不动", () => {
    values.set("biff.ranks.v1", '{"001":2,"002":1}');
    values.set("biff.agendafold.v1", '["2026-10-07"]');
    values.set("biff.tickets.v1", '{"001":{"state":"got"}}');
    values.set("biff.future.v9", '{ "unchanged": true }');
    hydrateStorage(cat);
    expect(values.has("biff.ranks.v1")).toBe(false);
    expect(values.has("biff.agendafold.v1")).toBe(false);
    expect(values.has("biff.tickets.v1")).toBe(false);
    // ⚠ 清理是**白名单**式的:不许顺手扫 `biff.` 前缀,里面还有一大批活键在跑。
    expect(values.get("biff.future.v9")).toBe('{ "unchanged": true }');
  });

  it("leaves the retired savedplans key byte-for-byte", () => {
    // 「已保存方案」已整体下线(2026-09-22,`PLAN-20260922105228`):这个键**不再被读**,
    // 但必须**原样留着** —— 数据契约只增不改,备份前缀快照与 `compatibility.spec.ts` 的字节级断言
    // 都依赖「加载旧数据不丢键」。哪天误把它读出来再写回去(或删掉),这条会红。
    const plans = '[{"id":"saved","name":"方案 1","codes":["001"],"createdAt":1}]';
    values.set("biff.savedplans.v1", plans);
    hydrateStorage(cat);
    hydrateStorage(cat);
    expect(values.get("biff.savedplans.v1")).toBe(plans);
  });
});
