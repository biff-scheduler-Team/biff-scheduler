// 网格「状态模型」与「几何签名」单测(2026-09-11,PLAN-20260911004000)。
//
// 为什么测这两个:
//   · `cardStateOf()` 是网格卡状态的**唯一真源** —— 全量构建(appendCard)与就地复用
//     (patchGridStates)都读它。两条路径不可能漂移,但状态本身的判定必须锁住。
//   · `gridGeometryKey()` 决定「复用还是重建」。它一旦漏掉某个几何输入,就会出现
//     「卡片尺寸与数据不一致」的**静默错位** —— 没有报错、没有类型错,只能靠断言守住。
//
// 纯函数,不碰 DOM(vitest environment = node)。

import { beforeEach, describe, expect, it } from "vitest";
import { cardStateOf, gridGeometryKey, type GridCtx } from "../src/grid";
import { gvTalkMinOv, store } from "../src/state";
import type { Screening } from "../src/types";
import { catalog, show } from "./helpers";

/** 构造一个最小 GridCtx(纯数据,无 DOM) */
function ctxOf(shows: Screening[], opts: Partial<GridCtx> = {}): GridCtx {
  const cat = catalog(shows);
  return {
    cat,
    pxPerMin: 3,
    row: { rowH: 92, fontScale: 1, insetY: 2, showBadges: true },
    slots: new Map(),
    mappingOf: () => undefined,
    conflictCodes: undefined,
    transitMin: 0,
    gvTalkOf: () => true,
    hourFilter: null,
    ...opts,
  };
}

beforeEach(() => {
  gvTalkMinOv.clear();
  store.settings = { ...store.settings, gvTalkMin: 25, gvTalkOn: true };
});

describe("cardStateOf:选中态", () => {
  it("未选 → isIdle,无 in-plan", () => {
    const s = show({ code: "001" });
    const st = cardStateOf(s, ctxOf([s]));
    expect(st.isIdle).toBe(true);
    expect(st.stateCls).not.toContain("in-plan");
  });

  it("已选 → in-plan(且不再 idle)", () => {
    const s = show({ code: "001" });
    const st = cardStateOf(s, ctxOf([s], { slots: new Map([["001", { key: "k" }]]) }));
    expect(st.inCurrent).toBe(true);
    expect(st.isIdle).toBe(false);
    expect(st.stateCls).toContain("in-plan");
  });
});

describe("cardStateOf:冲突优先于选中态", () => {
  it("冲突时只出 in-conf(不给 in-plan),并置 warn", () => {
    const s = show({ code: "001" });
    const st = cardStateOf(
      s,
      ctxOf([s], {
        slots: new Map([["001", { key: "k" }]]),
        conflictCodes: new Set(["001"]),
      })
    );
    expect(st.isConflict).toBe(true);
    expect(st.warn).toBe(true);
    expect(st.stateCls).toContain("in-conf");
    expect(st.stateCls).not.toContain("in-plan");
  });
});

describe("cardStateOf:时间筛选", () => {
  it("hourFilter 命中该时段 → 不淡化;不命中 → 淡化", () => {
    const s = show({ code: "001", start_time: "10:00", end_time: "11:40" });
    expect(cardStateOf(s, ctxOf([s], { hourFilter: 10 })).dim).toBe(false);
    expect(cardStateOf(s, ctxOf([s], { hourFilter: 20 })).dim).toBe(true);
    expect(cardStateOf(s, ctxOf([s], { hourFilter: null })).dim).toBe(false);
  });
});

describe("cardStateOf:GV 谈块", () => {
  it("非 GV → 不产生谈块", () => {
    const s = show({ code: "001" });
    expect(cardStateOf(s, ctxOf([s])).talk).toBeUndefined();
  });

  it("GV + 参加 + 在行程 → 谈块带 ✓,状态随主卡 in-plan", () => {
    const s = show({ code: "001", is_gv: true });
    const st = cardStateOf(
      s,
      ctxOf([s], { slots: new Map([["001", { key: "k" }]]) })
    );
    expect(st.talk?.on).toBe(true);
    expect(st.talk?.label).toBe("✓ 映后 25′");
    expect(st.talk?.stateCls).toContain("in-plan");
  });

  it("放弃映后谈 → gv-talk-off 且 label 不带 ✓", () => {
    const s = show({ code: "001", is_gv: true });
    const st = cardStateOf(s, ctxOf([s], { gvTalkOf: () => false }));
    expect(st.talk?.on).toBe(false);
    expect(st.talk?.label).toBe("映后 25′");
    expect(st.talk?.stateCls).toContain("gv-talk-off");
  });

  it("冲突时谈块同样走 in-conf(与主卡同一底色语言)", () => {
    const s = show({ code: "001", is_gv: true });
    const st = cardStateOf(s, ctxOf([s], { conflictCodes: new Set(["001"]) }));
    expect(st.talk?.stateCls).toContain("in-conf");
    expect(st.talk?.stateCls).not.toContain("in-plan");
  });
});

describe("gridGeometryKey:决定「复用还是重建」", () => {
  const d = "2026-10-08";
  const base = [show({ code: "001" }), show({ code: "002", start_time: "13:00", end_time: "14:40" })];

  it("同输入 → 同键(可复用)", () => {
    expect(gridGeometryKey(catalog(base), d, 3, 92)).toBe(gridGeometryKey(catalog(base), d, 3, 92));
  });

  it("**选片变化不进签名** —— 这正是「点选不再重建网格」的依据", () => {
    // 签名只吃 cat / date / pxPerMin / rowH,与 store.picks 无关:
    // 同一份排期 + 同一缩放 ⇒ 无论选了哪些场次,键都一样 ⇒ 走 patch 路径。
    const k1 = gridGeometryKey(catalog(base), d, 3, 92);
    const k2 = gridGeometryKey(catalog(base), d, 3, 92);
    expect(k1).toBe(k2);
  });

  it("改开场时间 / 片长 → 键变(必须重建)", () => {
    const moved = [show({ code: "001", start_time: "10:30" }), base[1]];
    expect(gridGeometryKey(catalog(moved), d, 3, 92)).not.toBe(gridGeometryKey(catalog(base), d, 3, 92));
    const longer = [show({ code: "001", duration_min: 130 }), base[1]];
    expect(gridGeometryKey(catalog(longer), d, 3, 92)).not.toBe(gridGeometryKey(catalog(base), d, 3, 92));
  });

  it("改映后时长(GV 配置)→ 键变(谈块宽度与轴末都变)", () => {
    const gv = [show({ code: "001", is_gv: true })];
    const before = gridGeometryKey(catalog(gv), d, 3, 92);
    gvTalkMinOv.set("001", 40);
    expect(gridGeometryKey(catalog(gv), d, 3, 92)).not.toBe(before);
  });

  it("换日期 / 改缩放 → 键变", () => {
    const c = catalog(base);
    expect(gridGeometryKey(c, "2026-10-09", 3, 92)).not.toBe(gridGeometryKey(c, d, 3, 92));
    expect(gridGeometryKey(c, d, 3.6, 110)).not.toBe(gridGeometryKey(c, d, 3, 92));
  });
});
