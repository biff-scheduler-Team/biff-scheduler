// 口径单一来源的回归测试（2026-09-23，PLAN-20260923111748，B3）。
//
// 为什么单开一个文件：这些断言跨模块，钉的都是「同一样东西只允许有一份实现」——
//   · 时间区间（跨午夜必须显示「次日 05:35」，不能把 24+ 时制的 29:35 印给用户）；
//   · 时长文案（四处 `{n} 分钟` + 一处 `{n}min` 已收口到 `fmtDuration`）；
//   · 取整（匿名权重 0.75 必须 round 而不是 trunc，三份副本已收口到 `wholeCount`）。
//
// 纯函数，不碰 DOM（vitest environment = node）。

import { beforeEach, describe, expect, it } from "vitest";
import { cardStateOf, type GridCtx } from "../src/grid";
import { gvTalkMinOv, store } from "../src/state";
import type { Screening } from "../src/types";
import { fmtDuration, fmtMinRange, safeExternalUrl, wholeCount } from "../src/util";
import { catalog, show } from "./helpers";

/** 构造一个最小 GridCtx（与 `grid-state.test.ts` 同一套脚手架）。 */
function ctxOf(shows: Screening[], opts: Partial<GridCtx> = {}): GridCtx {
  return {
    cat: catalog(shows),
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

describe("fmtDuration：时长文案的唯一来源", () => {
  it("中文档位带空格，short 给 .ics 用", () => {
    expect(fmtDuration(90)).toBe("90 分钟");
    expect(fmtDuration(90, "short")).toBe("90min");
  });

  it("脏值夹成 0 而不是印出 NaN 分钟", () => {
    expect(fmtDuration(Number.NaN)).toBe("0 分钟");
    expect(fmtDuration(89.6)).toBe("90 分钟");
  });
});

describe("wholeCount：取整的唯一来源", () => {
  it("用 round 而不是 trunc —— 匿名权重 0.75 的 3 人必须读成 3", () => {
    expect(wholeCount(2.25)).toBe(2);
    expect(wholeCount(2.75)).toBe(3);
    expect(wholeCount("0.75")).toBe(1);
  });

  it("脏值 / 非正数 → 0", () => {
    expect(wholeCount(Number.NaN)).toBe(0);
    expect(wholeCount(-5)).toBe(0);
    expect(wholeCount(null)).toBe(0);
  });
});

describe("safeExternalUrl：外链协议闸门", () => {
  it("放行绝对的 http / https", () => {
    expect(safeExternalUrl("https://map.naver.com/p/search/x")).toBe(
      "https://map.naver.com/p/search/x",
    );
    expect(safeExternalUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("★ 拒绝伪协议与相对路径（上游 URL 只校验过「是字符串」就直接进 href）", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeExternalUrl("/relative/path")).toBeUndefined();
    expect(safeExternalUrl("map.naver.com")).toBeUndefined();
    expect(safeExternalUrl("")).toBeUndefined();
    expect(safeExternalUrl(null)).toBeUndefined();
    expect(safeExternalUrl(42)).toBeUndefined();
  });

  it("对照：伪协议本身就是合法 URL —— 只判「能构造 URL」是挡不住的", () => {
    expect(new URL("javascript:alert(1)").protocol).toBe("javascript:");
  });
});

describe("fmtMinRange：跨午夜区间", () => {
  it("24+ 时制的终点折回并带「次日」", () => {
    expect(fmtMinRange("23:59", "29:35")).toBe("23:59–次日 05:35");
  });
});

describe("cardStateOf：冲突提示的区间文案（R5）", () => {
  it("★ 午夜场印「次日 05:35」，不再把 24+ 原值 29:35 印给用户", () => {
    const midnight = show({ code: "001", start_time: "23:59", end_time: "29:35" });
    const other = show({ code: "002", start_time: "23:00", end_time: "24:30" });
    const state = cardStateOf(
      other,
      ctxOf([midnight, other], {
        conflictCodes: new Set(["002"]),
        conflictPairs: [["001", "002"]],
      }),
    );
    expect(state.conflictTip).toContain("23:59–次日 05:35");
    expect(state.conflictTip).not.toContain("29:35");
  });
});
