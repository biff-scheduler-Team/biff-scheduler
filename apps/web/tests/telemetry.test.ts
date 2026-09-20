// 事件流水客户端单测（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
//
// 覆盖点：① 读取端白名单（脏值 / 全 0 行被丢弃）；② click 只认白名单 slug；
// ③ 待发缓冲按 target 累加；④ **上报体里绝不带查询串**（「搜索不进统计」在客户端的实现）；
// ⑤ 接口失败静默丢弃，不留待发队列。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLICK_TARGETS,
  flushTelemetry,
  parseTelemetryCounts,
  pendingTelemetrySize,
  resetTelemetryBuffer,
  trackClick,
  trackPageView,
} from "../src/telemetry";

const calls: Array<{ url: string; body: unknown }> = [];

/** 上报调用（**排除**上报成功后那次「重读计数」的 GET —— 它是另一件事）。 */
const pings = () => calls.filter((call) => call.url.includes("telemetry-ping"));

beforeEach(() => {
  calls.length = 0;
  resetTelemetryBuffer();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: async () => ({ counts: {} }) });
  });
});

afterEach(() => {
  resetTelemetryBuffer();
  vi.unstubAllGlobals();
});

describe("parseTelemetryCounts", () => {
  it("只收白名单 kind，丢弃全 0 行与脏值", () => {
    const counts = parseTelemetryCounts({
      page: {
        "/schedule": { viewers: 3, hits: 9 },
        "/empty": { viewers: 0, hits: 0 },
        "/bad": { viewers: "x", hits: Number.NaN },
      },
      click: { screening: { viewers: 2, hits: 5 } },
      search: { 王家卫: { viewers: 1, hits: 1 } },
    });
    expect(Object.keys(counts.page!)).toEqual(["/schedule"]);
    expect(Object.keys(counts.click!)).toEqual(["screening"]);
    // search 不是白名单 kind → 整个桶被丢掉
    expect((counts as Record<string, unknown>).search).toBeUndefined();
  });

  it("非对象 / 空 → 空表", () => {
    expect(parseTelemetryCounts(null)).toEqual({});
    expect(parseTelemetryCounts("x")).toEqual({});
  });
});

describe("采集", () => {
  it("click 只认白名单 slug（DOM 上的 data-track 是手写的，写错宁可不发）", () => {
    for (const target of CLICK_TARGETS) trackClick(target);
    trackClick("随便写的");
    trackClick("");
    expect(pendingTelemetrySize()).toBe(CLICK_TARGETS.length);
  });

  it("同一 target 反复触发累加而不是各占一条", () => {
    trackPageView("/schedule");
    trackPageView("/schedule");
    trackClick("screening");
    expect(pendingTelemetrySize()).toBe(2);
  });

  it("相对路径 / 非路径一律不记（只接受 location.pathname 那种形状）", () => {
    trackPageView("schedule");
    trackPageView("");
    expect(pendingTelemetrySize()).toBe(0);
  });
});

describe("上报", () => {
  it("查询串在客户端就被剥掉，且请求体只有 kind / target / hits", async () => {
    trackPageView("/library?q=王家卫");
    trackPageView("/schedule#x");
    trackClick("film");
    await flushTelemetry();
    expect(pings()).toHaveLength(1);
    const body = pings()[0].body as { events: Array<{ kind: string; target: string; hits: number }> };
    // ★ 这一条就是「搜索完全不进统计」的机械证明：搜索词唯一的载体（查询串）根本没上行
    expect(body.events.map((event) => `${event.kind}:${event.target}`).sort()).toEqual([
      "click:film",
      "page:/library",
      "page:/schedule",
    ]);
    for (const event of body.events) {
      expect(Object.keys(event).sort()).toEqual(["hits", "kind", "target"]);
    }
    expect(JSON.stringify(body)).not.toContain("王家卫");
  });

  it("发完就清空缓冲（不重试、不留队列）", async () => {
    trackClick("export");
    await flushTelemetry();
    expect(pendingTelemetrySize()).toBe(0);
    await flushTelemetry();
    expect(pings()).toHaveLength(1);
  });

  it("接口失败静默丢弃，不抛错、不留待发", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    trackClick("ticket");
    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(pendingTelemetrySize()).toBe(0);
  });
});
