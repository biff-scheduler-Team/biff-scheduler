// 抢票结果客户端缓存与上报单测（2026-09-20,PLAN-20260920161837）。
//
// 重点与 `film-votes.test.ts` 一致：**容错**（接口没部署 / 断网 / 半截响应都不能把页面拖挂）
// 与**隐私边界**（请求体只准带场次 code 与结果，不得夹带备注 / 片单 / 身份）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
const fail = (status = 404) => Promise.resolve({ ok: false, status } as unknown as Response);

describe("parseTicketCounts 白名单", () => {
  it("丢弃非法条目、四项全 0 不输出、负数夹回 0、字符串数字认", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(
      parseTicketCounts({
        "001": { got: 3, transfer: 1, missed: 2, dropped: 0 },
        "002": { got: 0, transfer: 0, missed: 0, dropped: 0 },
        "003": { got: "2", transfer: -5, missed: 1, dropped: 0 },
        "004": null,
        "005": "nope",
      }),
    ).toEqual({
      "001": { got: 3, transfer: 1, missed: 2, dropped: 0 },
      "003": { got: 2, transfer: 0, missed: 1, dropped: 0 },
    });
    expect(parseTicketCounts(null)).toEqual({});
    expect(parseTicketCounts("nope")).toEqual({});
  });

  it("只带转票的场次也要保留（转票获得数本身是可见指标）", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(parseTicketCounts({ "001": { transfer: 2 } })).toEqual({
      "001": { got: 0, transfer: 2, missed: 0, dropped: 0 },
    });
  });
});

describe("loadTicketCounts 容错", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("接口还没部署(404)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { loadTicketCounts, peekTicketCounts } = await import("../src/ticket-stats");
    await expect(loadTicketCounts()).resolves.toEqual({});
    expect(peekTicketCounts()).toEqual({});
  });

  it("断网(网络异常)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const { loadTicketCounts } = await import("../src/ticket-stats");
    await expect(loadTicketCounts()).resolves.toEqual({});
  });

  it("正常响应 → 解析进缓存", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson({ tickets: { "001": { got: 2, transfer: 1, missed: 0, dropped: 0 } } })),
    );
    const { loadTicketCounts, peekTicketCounts } = await import("../src/ticket-stats");
    await loadTicketCounts();
    expect(peekTicketCounts()).toEqual({ "001": { got: 2, transfer: 1, missed: 0, dropped: 0 } });
  });
});

describe("scheduleTicketPing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("1200ms 防抖:窗口内多次调用只发一条,同一场以最后一次为准", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleTicketPing } = await import("../src/ticket-stats");

    scheduleTicketPing([{ code: "001", state: "got" }]);
    scheduleTicketPing([
      { code: "001", state: "missed" }, // 同场后到者胜
      { code: "002", state: "got", via: "transfer" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/stats/ticket-results-ping");
    expect(JSON.parse(String(init.body))).toMatchObject({
      entries: [
        { code: "001", state: "missed" },
        { code: "002", state: "got", via: "transfer" },
      ],
    });
  });

  it("隐私边界:请求体只有 edition + entries,且每条只有 code / state / via", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleTicketPing } = await import("../src/ticket-stats");

    scheduleTicketPing([
      { code: "001", state: "got" },
      { code: "002", state: "dropped", via: "transfer" },
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { edition: string; entries: unknown[] };
    expect(Object.keys(body).sort()).toEqual(["edition", "entries"]);
    for (const entry of body.entries) {
      expect(Object.keys(entry as object).every((k) => ["code", "state", "via"].includes(k))).toBe(true);
    }
  });

  it("上报条数截到 500(与 api 侧 MAX_TICKET_ENTRIES_PER_PING 对齐)", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleTicketPing, MAX_TICKET_ENTRIES_PER_PING } = await import("../src/ticket-stats");

    expect(MAX_TICKET_ENTRIES_PER_PING).toBe(500);
    scheduleTicketPing(
      Array.from({ length: 600 }, (_, i) => ({ code: `c${i}`, state: "got" as const })),
    );
    await vi.advanceTimersByTimeAsync(1200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { entries: unknown[] }).entries).toHaveLength(500);
  });
});
