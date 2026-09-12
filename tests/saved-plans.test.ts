// 「已保存方案」的纯逻辑单测(2026-09-12)。
//
// 为什么单测它:保存 / 去重 / 删除是**用户数据的唯一写入口**,且判定全是纯逻辑
// (集合比较、自动命名、localStorage 往返)—— 不抛错、不报类型错,只能靠断言守住。
// 用内存 localStorage 替身而非 jsdom:被测模块在 import 期不碰 localStorage(真机入口才读)。

import { beforeEach, describe, expect, it } from "vitest";
import { deletePlan, loadSavedPlans, savePlan, savedPlans } from "../src/state";

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
  savedPlans.length = 0;
  mem.clear();
});

describe("savePlan:保存 / 去重 / 自动命名", () => {
  it("空集合 → 不保存", () => {
    expect(savePlan([]).reason).toBe("empty");
    expect(savedPlans.length).toBe(0);
  });

  it("保存 → 自动命名「方案 1」,并落盘", () => {
    const r = savePlan(["001", "002"]);
    expect(r.ok).toBe(true);
    expect(r.plan?.name).toBe("方案 1");
    expect(r.plan?.codes).toEqual(["001", "002"]);
    expect(JSON.parse(mem.get("biff.savedplans.v1")!)).toHaveLength(1);
  });

  it("重复 code 去重", () => {
    expect(savePlan(["001", "001", "002"]).plan?.codes).toEqual(["001", "002"]);
  });

  it("场次集合相同(顺序无关)→ duplicate,不重复存", () => {
    savePlan(["001", "002"]);
    expect(savePlan(["002", "001"]).reason).toBe("duplicate");
    expect(savedPlans.length).toBe(1);
  });

  it("集合不同 → 追加为「方案 2」", () => {
    savePlan(["001", "002"]);
    const r = savePlan(["001", "002", "003"]);
    expect(r.plan?.name).toBe("方案 2");
    expect(savedPlans.length).toBe(2);
  });

  it("删掉中间一个后新增不撞名(取已有最大 N + 1)", () => {
    savePlan(["a"]);
    savePlan(["b"]);
    deletePlan(savedPlans[0].id);
    expect(savePlan(["c"]).plan?.name).toBe("方案 3");
  });
});

describe("loadSavedPlans:从 localStorage 恢复", () => {
  it("非法条目静默丢弃,合法条目原样读回", () => {
    mem.set(
      "biff.savedplans.v1",
      JSON.stringify([
        { id: "p1", name: "方案 1", codes: ["001"], createdAt: 1 },
        { id: "", name: "坏数据", codes: ["002"] },
        { id: "p3", codes: ["003", 42] },
        "不是对象",
      ])
    );
    loadSavedPlans();
    expect(savedPlans.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(savedPlans[1].codes).toEqual(["003"]);
    expect(savedPlans[1].name).toBe("方案 2"); // 缺 name → 兜底
  });
});

describe("deletePlan", () => {
  it("按 id 删除;id 不存在 → 无副作用", () => {
    savePlan(["a"]);
    savePlan(["b"]);
    deletePlan("不存在");
    expect(savedPlans.length).toBe(2);
    deletePlan(savedPlans[0].id);
    expect(savedPlans.length).toBe(1);
    expect(savedPlans[0].codes).toEqual(["b"]);
  });
});
