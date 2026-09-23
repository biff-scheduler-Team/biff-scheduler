// 悬停高亮外部 store 的回归测试（2026-09-23，PLAN-20260923111748，B5）。
//
// 为什么必须钉住：高亮此前是 Context + useState —— `setCode` 会让所有消费者重渲染，
// 而画布每个 slot 在 render 里都要跑 filmInfoOf / doubaoScoreOf / cardStateOf / screeningMembers，
// 于是「鼠标划过网格」= 连续多次全届级重计算。改为模块级 store + DOM 直改之后，
// 行为契约必须由测试锁住：① 同值不通知（hover 在同格内反复触发不该有任何工作）；
// ② 退订真的摘掉监听（否则页面切换后会越攒越多）；
// ③ 「哪几场一起亮」仍是冲突组口径，且同一 ConflictResult 上重复问只算一次。
//
// 纯逻辑，不碰 DOM（vitest environment = node）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  highlightCodesFor,
  highlightedCode,
  setHighlight,
  subscribeHighlight,
} from "../src/app/highlight";
import type { ConflictResult } from "../src/conflict";
import { catalog, show } from "./helpers";

beforeEach(() => {
  setHighlight(null);
});

describe("highlight store", () => {
  it("setHighlight 通知订阅者，highlightedCode 反映最新值", () => {
    const listener = vi.fn();
    const off = subscribeHighlight(listener);
    setHighlight("001");
    expect(highlightedCode()).toBe("001");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("同值不通知；空串归一成 null（hover 在同格内反复触发不该产生工作）", () => {
    const listener = vi.fn();
    const off = subscribeHighlight(listener);
    setHighlight("001");
    setHighlight("001");
    expect(listener).toHaveBeenCalledTimes(1);
    setHighlight("");
    expect(highlightedCode()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it("退订后不再收到通知（否则页面切换后监听会越攒越多）", () => {
    const listener = vi.fn();
    subscribeHighlight(listener)();
    setHighlight("001");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("highlightCodesFor：一起亮的场次", () => {
  const day = [
    show({ code: "001", start_time: "10:00", end_time: "11:40" }),
    show({ code: "002", start_time: "11:00", end_time: "12:40" }),
    show({ code: "003", start_time: "20:00", end_time: "21:40" }),
  ];
  const conflictsOf = new Map<string, ConflictResult>([
    ["2026-10-08", { codeSet: new Set(["001", "002"]), pairs: [["001", "002"]] }],
  ]);

  it("没有高亮 → 空集", () => {
    expect([...highlightCodesFor(catalog(day), conflictsOf, null)]).toEqual([]);
  });

  it("高亮冲突组里的一场 → 整组一起亮", () => {
    const codes = highlightCodesFor(catalog(day), conflictsOf, "001");
    expect([...codes].sort()).toEqual(["001", "002"]);
  });

  it("高亮不冲突的一场 → 只有它自己", () => {
    const codes = highlightCodesFor(catalog(day), conflictsOf, "003");
    expect([...codes]).toEqual(["003"]);
  });

  it("同一 ConflictResult 上重复问只展开一次（WeakMap 缓存，卡片列表每张卡都会问）", () => {
    const cat = catalog(day);
    const first = highlightCodesFor(cat, conflictsOf, "001");
    const second = highlightCodesFor(cat, conflictsOf, "001");
    expect(second).toBe(first);
  });
});
