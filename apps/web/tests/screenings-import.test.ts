// `.ics` / 备份导入的落盘口径单测。
//
// ⚠ 本文件原名 `saved-plans.test.ts`(2026-09-12):它同时被测了「已保存方案」的保存 / 去重 /
//   自动命名 / localStorage 往返。方案已于 2026-09-22 整体下线(`PLAN-20260922105228`),
//   那些用例随实现一起删除,只留下这两个与行程本身有关的口径 —— 故按它现在测的东西改名。
//
// 为什么单测它:导入是**用户行程的批量写入口**,判定全是纯逻辑(并集、清空时怎么保留备注),
// 不抛错、不报类型错,只能靠断言守住。用内存 localStorage 替身而非 jsdom:
// 被测模块在 import 期不碰 localStorage(真机入口才读)。

import { beforeEach, describe, expect, it } from "vitest";
import { mergeScreenings, replaceScreenings, store } from "../src/state";

/** 最小内存 localStorage 替身 —— state.ts 直接用全局 localStorage,故挂到 globalThis */
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  get length(): number {
    return mem.size;
  },
  key: (i: number): string | null => [...mem.keys()][i] ?? null,
  getItem: (k: string): string | null => mem.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    mem.set(k, v);
  },
  removeItem: (k: string): void => {
    mem.delete(k);
  },
  clear: (): void => {
    mem.clear();
  },
};

beforeEach(() => {
  store.picks.clear();
  mem.clear();
});

describe("replaceScreenings / mergeScreenings:.ics 导入落盘", () => {
  /** 极简 key 口径:`100` → `film:1`(同首位数字归同一部片),非纯数字返回 null */
  const keyOf = (code: string): string | null => (/^\d+$/.test(code) ? `film:${code[0]}` : null);

  it("merge:并入现有行程,已有的不重复加,备注不动", () => {
    store.picks.set("film:1", { key: "film:1", picks: [{ code: "100" }], note: "备注A" });
    mergeScreenings(["100", "200"], keyOf);
    expect(store.picks.get("film:1")?.picks.map((p) => p.code)).toEqual(["100"]);
    expect(store.picks.get("film:1")?.note).toBe("备注A");
    expect(store.picks.get("film:2")?.picks.map((p) => p.code)).toEqual(["200"]);
  });

  it("replace:清空现有场次;有备注的记录保留(降级为未排场),无备注空壳整条删", () => {
    store.picks.set("film:1", { key: "film:1", picks: [{ code: "100" }], note: "备注A" });
    store.picks.set("film:9", { key: "film:9", picks: [{ code: "900" }], note: "" });
    replaceScreenings(["200"], keyOf);
    expect(store.picks.get("film:1")).toEqual({ key: "film:1", picks: [], note: "备注A" });
    expect(store.picks.has("film:9")).toBe(false);
    expect(store.picks.get("film:2")?.picks.map((p) => p.code)).toEqual(["200"]);
  });

  it("keyOf 返回 null 的 code 静默跳过(排期换版残留)", () => {
    mergeScreenings(["abc"], keyOf);
    expect(store.picks.size).toBe(0);
  });
});
