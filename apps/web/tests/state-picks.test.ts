// 「移除行程里的一场」口径单测(2026-09-13,PLAN-20260913180837)。
//
// 为什么单测它:「移除这一场」与「移除整部影片」是两个动作,分界线只在 picks 变空的那一刻。
// 写错了不抛错、不报类型错 —— 只会让用户「点错一下,整部片就从选片里消失」
// (2026-09-13 用户实测)。口径:移除某一场**只动 picks,记录一律保留**;
// picks 为空 = 合法的「已选未排场」态(与 addPickFilm 建出的空记录同构)。
//
// 用内存 localStorage 替身而非 jsdom:被测模块 import 期不碰 localStorage(真机入口才读)。
// 初始状态走 `loadPicks()`(= hydrate + rebuildIndex 的真实路径),不手搓派生索引。

import { beforeEach, describe, expect, it } from "vitest";
import {
  allCodes,
  loadPicks,
  rankOf,
  removePick,
  removeScreening,
  slotOf,
  store,
  toggleScreening,
} from "../src/state";
import type { PickEntry } from "../src/types";

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

const LS_PICKS = "biff.picks.v2";
const LS_RANKS = "biff.ranks.v1";

/** 以给定记录为初始态(经 `loadPicks()` 建 picks / slotIndex / allIndex,并 prune 顺位) */
function seed(entries: PickEntry[]): void {
  store.picks.clear();
  mem.set(LS_PICKS, JSON.stringify(entries));
  loadPicks(() => null);
}

/** 落盘后的 picks 记录(断言「真的写进 localStorage」,而不是只看内存) */
function persisted(): PickEntry[] {
  return JSON.parse(mem.get(LS_PICKS)!) as PickEntry[];
}

beforeEach(() => {
  store.picks.clear();
  rankOf.clear();
  mem.clear();
});

describe("toggleScreening:移出最后一场不删记录", () => {
  it("只剩一场且无备注 → 记录保留为「未排场」,不再整条删", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "" }]);
    toggleScreening("film:a", "001");
    expect(store.picks.get("film:a")).toEqual({ key: "film:a", picks: [], note: "" });
    expect(persisted()).toEqual([{ key: "film:a", picks: [], note: "" }]);
  });

  it("备注原样保留(不得连备注一起丢)", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "等嘉宾" }]);
    toggleScreening("film:a", "001");
    expect(store.picks.get("film:a")?.note).toBe("等嘉宾");
  });

  it("多场只移出一场 → 其余场次不动", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }, { code: "002" }], note: "" }]);
    toggleScreening("film:a", "001");
    expect(store.picks.get("film:a")?.picks).toEqual([{ code: "002" }]);
  });

  it("移出后派生索引同步清空(该场不再算「已排」)", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "" }]);
    toggleScreening("film:a", "001");
    expect(slotOf("001")).toBeUndefined();
    expect(allCodes()).toEqual([]);
  });

  it("空记录(未排场)再点「加入行程」→ 挂上场次,不新建重复记录", () => {
    seed([{ key: "film:a", picks: [], note: "备注A" }]);
    toggleScreening("film:a", "001");
    expect(store.picks.size).toBe(1);
    expect(store.picks.get("film:a")).toEqual({
      key: "film:a",
      picks: [{ code: "001" }],
      note: "备注A",
    });
  });
});

describe("removeScreening:与 toggleScreening 同口径", () => {
  it("最后一场移除 → 记录保留、备注保留", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "想看" }]);
    removeScreening("001");
    expect(store.picks.get("film:a")).toEqual({ key: "film:a", picks: [], note: "想看" });
    expect(slotOf("001")).toBeUndefined();
  });

  it("最后一场且无备注 → 同样保留(旧实现在这里整条删)", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "" }]);
    removeScreening("001");
    expect(store.picks.get("film:a")).toEqual({ key: "film:a", picks: [], note: "" });
    expect(persisted()).toEqual([{ key: "film:a", picks: [], note: "" }]);
  });

  it("该场的抢票顺位被 prune(场次没了,顺位就是脏数据)", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "" }]);
    rankOf.set("001", 1);
    mem.set(LS_RANKS, JSON.stringify({ "001": 1 }));
    removeScreening("001");
    expect(rankOf.has("001")).toBe(false);
    expect(JSON.parse(mem.get(LS_RANKS)!)).toEqual({});
  });

  it("不在行程里的 code → 无副作用", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "" }]);
    removeScreening("999");
    expect(store.picks.get("film:a")?.picks).toEqual([{ code: "001" }]);
  });
});

describe("removePick:要真删有显式出口", () => {
  it("整片移除 → 记录连同备注、场次一起删", () => {
    seed([{ key: "film:a", picks: [{ code: "001" }], note: "备注A" }]);
    removePick("film:a");
    expect(store.picks.has("film:a")).toBe(false);
    expect(persisted()).toEqual([]);
    expect(slotOf("001")).toBeUndefined();
  });
});
