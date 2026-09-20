// 事件流水服务端口径单测（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
//
// 覆盖点：① kind 白名单（**没有 search**）；② target 形状白名单 —— 这是「自由文本进不来」的闸门；
// ③ 页面路径归一化 + **查询串被丢掉**（搜索词唯一的载体）；④ 增量累加而不是覆盖；
// ⑤ 单条次数上限（防伪造）；⑥ 非法条目静默丢弃。

import { describe, expect, it } from "vitest";
import {
  MAX_HITS_PER_TARGET,
  isClickTargetSlug,
  isNormalizedTarget,
  isPageTarget,
  isTelemetryKind,
  normalizePath,
  normalizeTelemetryEntries,
  planTelemetryDelta,
} from "../src/telemetry-stats";

describe("kind 白名单", () => {
  it("只有 page / click —— search 不存在（用户明确「搜索完全不进统计」）", () => {
    expect(isTelemetryKind("page")).toBe(true);
    expect(isTelemetryKind("click")).toBe(true);
    expect(isTelemetryKind("search")).toBe(false);
    expect(isTelemetryKind("")).toBe(false);
    expect(isTelemetryKind(null)).toBe(false);
  });
});

describe("两套 target 白名单（隐私闸门）", () => {
  it("click 只认共享契约里的固定 slug —— 任意 slug 形状的串也不行", () => {
    expect(isClickTargetSlug("screening")).toBe(true);
    expect(isClickTargetSlug("export")).toBe(true);
    // 形状合法但不在白名单 → 拒绝（否则任意 slug 都能把榜单撑成随机长尾）
    expect(isClickTargetSlug("whatever-random")).toBe(false);
    expect(isClickTargetSlug("/schedule")).toBe(false);
    expect(isClickTargetSlug("王家卫")).toBe(false);
  });

  it("page 只认路径形状，拒绝自由文本", () => {
    expect(isPageTarget("/schedule")).toBe(true);
    expect(isPageTarget("/films/f001")).toBe(true);
    // ⚠ 入站正则**不含 `*`**：`*` 只可能是归一化产物，不是客户端能发上来的东西
    expect(isPageTarget("/films/*")).toBe(false);
    // 搜索词 / 片名 / 备注这类自由文本**不可能**匹配这个形状
    expect(isPageTarget("王家卫")).toBe(false);
    expect(isPageTarget("hone y")).toBe(false);
    expect(isPageTarget("schedule")).toBe(false);
    expect(isPageTarget("")).toBe(false);
    expect(isPageTarget("a".repeat(65))).toBe(false);
  });

  it("存储态校验与入站校验分开：归一化产物（含 `*`）在存储态是合法的", () => {
    // 入站不接受 `*`，存储态必须接受 —— 否则读表时会把「影片资料」整行丢掉
    expect(isNormalizedTarget("page", "/films/*")).toBe(true);
    expect(isNormalizedTarget("page", "/schedule")).toBe(true);
    expect(isNormalizedTarget("page", "/library?q=x")).toBe(false);
    expect(isNormalizedTarget("click", "screening")).toBe(true);
    expect(isNormalizedTarget("click", "whatever-random")).toBe(false);
    expect(isNormalizedTarget("page", "")).toBe(false);
  });
});

describe("normalizePath", () => {
  it("折叠带 id 的第二段，避免「每部片一个键」", () => {
    expect(normalizePath("/films/f001")).toBe("/films/*");
    expect(normalizePath("/films/abc123")).toBe("/films/*");
    // 非 id 的第二段保留
    expect(normalizePath("/rush-analysis")).toBe("/rush-analysis");
    expect(normalizePath("/films")).toBe("/films");
  });

  it("查询串与哈希被丢掉 —— 搜索词唯一的载体就在这里断掉", () => {
    expect(normalizePath("/library?q=%E7%8E%8B%E5%AE%B6%E5%8D%AB")).toBe("/library");
    expect(normalizePath("/schedule?date=2026-10-07#x")).toBe("/schedule");
  });

  it("非法输入 → null（相对路径 / 空 / 非字符串）", () => {
    expect(normalizePath("schedule")).toBeNull();
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath(42 as unknown as string)).toBeNull();
  });
});

describe("normalizeTelemetryEntries", () => {
  it("同一 (kind, target) **累加**次数（计数型不能像状态型那样覆盖）", () => {
    const deltas = normalizeTelemetryEntries([
      { kind: "page", target: "/schedule", hits: 2 },
      { kind: "page", target: "/schedule", hits: 3 },
    ]);
    expect([...deltas.values()]).toEqual([{ kind: "page", target: "/schedule", hits: 5 }]);
  });

  it("page 走路径归一化，click 必须是契约里的 slug", () => {
    const deltas = normalizeTelemetryEntries([
      { kind: "page", target: "/films/f001", hits: 1 },
      { kind: "click", target: "screening", hits: 1 },
      // click 传路径 → 丢弃（click 的语义是入口 slug，不是页面）
      { kind: "click", target: "/schedule", hits: 1 },
      // 形状合法但不在 slug 白名单 → 丢弃
      { kind: "click", target: "whatever-random", hits: 1 },
      // search 类别不存在 → 丢弃
      { kind: "search", target: "王家卫", hits: 1 },
      { kind: "page", target: "/library?q=秘密", hits: 1 },
    ]);
    expect([...deltas.keys()].sort()).toEqual(["click|screening", "page|/films/*", "page|/library"]);
  });

  it("单条次数被钳到上限（一次 ping 报十万次是伪造的特征）", () => {
    const deltas = normalizeTelemetryEntries([{ kind: "page", target: "/eats", hits: 100000 }]);
    expect([...deltas.values()][0].hits).toBe(MAX_HITS_PER_TARGET);
  });

  it("非法条目静默丢弃：0 / 负 / 非数字 hits、缺字段、非对象", () => {
    const deltas = normalizeTelemetryEntries([
      { kind: "page", target: "/eats", hits: 0 },
      { kind: "page", target: "/eats", hits: -3 },
      { kind: "page", target: "/eats", hits: Number.NaN },
      { kind: "page", hits: 2 },
      { target: "/eats", hits: 2 },
      null,
      "x",
    ]);
    expect(deltas.size).toBe(0);
  });
});

describe("planTelemetryDelta（计数型的增量算术）", () => {
  it("首次出现：viewers 加一份权重，hits 加「权重 × 次数」", () => {
    expect(planTelemetryDelta(null, 3, 0.75)).toEqual({
      nextHits: 3,
      viewerDelta: 0.75,
      hitsDelta: 2.25,
    });
  });

  it("再次出现：viewers 不动，hits 只加这一次", () => {
    expect(planTelemetryDelta({ hits: 3, weight: 0.75 }, 2, 0.75)).toEqual({
      nextHits: 5,
      viewerDelta: 0,
      hitsDelta: 1.5,
    });
  });

  it("权重变化（匿名 0.75 → 登录 1.0）：历史次数也要按新权重补差", () => {
    // 目标：viewers 0.75 → 1（Δ+0.25）；hits 0.75×3=2.25 → 1.0×(3+2)=5（Δ+2.75）
    // ⚠ 差值里的历史部分必须用**旧次数**（3）—— 用新次数（5）会多算 2×0.25=0.5
    expect(planTelemetryDelta({ hits: 3, weight: 0.75 }, 2, 1)).toEqual({
      nextHits: 5,
      viewerDelta: 0.25,
      hitsDelta: 2.75,
    });
  });

  it("权重降回（1.0 → 0.75）时同样按旧次数回退，两个增量都可以为负", () => {
    // 目标：hits 1×4=4 → 0.75×5=3.75，故 Δ = −0.25（**可以为负** —— 聚合表里那两个和
    // 本来就要能被减回去，`clearContributorTelemetry` 走的也是这条算术）
    expect(planTelemetryDelta({ hits: 4, weight: 1 }, 1, 0.75)).toEqual({
      nextHits: 5,
      viewerDelta: -0.25,
      hitsDelta: -0.25,
    });
  });

  it("脏值被夹成非负，不会算出负数次数", () => {
    expect(planTelemetryDelta({ hits: -5, weight: -1 }, 2, 0.75)).toEqual({
      nextHits: 2,
      viewerDelta: 0.75,
      hitsDelta: 1.5,
    });
  });
});
