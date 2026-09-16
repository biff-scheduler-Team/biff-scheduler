import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 红黑榜「大家的票」客户端:重点是**容错** —— 接口还没部署(404)、断网、半截响应,
// 页面都必须照常能用(退化成「大家的票为空」),绝不能把红黑榜整页拖挂。

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
const fail = (status = 404) => Promise.resolve({ ok: false, status } as unknown as Response);

describe("parseVotes 白名单", () => {
  it("丢弃非法条目、0 票不输出、负数夹回 0、字符串数字认", async () => {
    const { parseVotes } = await import("../src/film-votes");
    expect(
      parseVotes({
        a: { red: 3, black: 1 },
        b: { red: 0, black: 0 },
        c: { red: "2", black: -5 },
        d: null,
        e: "nope",
      }),
    ).toEqual({ a: { red: 3, black: 1 }, c: { red: 2, black: 0 } });
    expect(parseVotes(null)).toEqual({});
    expect(parseVotes("nope")).toEqual({});
  });
});

describe("loadFilmVotes 容错", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("接口还没部署(404)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { loadFilmVotes, peekFilmVotes } = await import("../src/film-votes");
    await expect(loadFilmVotes()).resolves.toEqual({});
    expect(peekFilmVotes()).toEqual({});
  });

  it("断网(网络异常)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const { loadFilmVotes } = await import("../src/film-votes");
    await expect(loadFilmVotes()).resolves.toEqual({});
  });

  it("正常响应 → 解析进缓存", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson({ votes: { a: { red: 2, black: 1 }, b: { red: 0, black: 0 } } })),
    );
    const { loadFilmVotes, peekFilmVotes } = await import("../src/film-votes");
    await loadFilmVotes();
    expect(peekFilmVotes()).toEqual({ a: { red: 2, black: 1 } });
  });
});

describe("scheduleFilmVotesPing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("1200ms 防抖:窗口内多次调用只发一条,同一部片以最后一次为准", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    scheduleFilmVotesPing([
      { key: "a", vote: "black" },
      { key: "b", vote: "red" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/stats/film-votes-ping");
    expect(JSON.parse(String(init.body))).toMatchObject({
      votes: [
        { key: "a", vote: "black" },
        { key: "b", vote: "red" },
      ],
    });
  });

  it("上报条数截到 500(与 api 侧 MAX_VOTES_PER_PING 对齐)", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, MAX_VOTES_PER_PING } = await import("../src/film-votes");

    expect(MAX_VOTES_PER_PING).toBe(500);
    scheduleFilmVotesPing(
      Array.from({ length: 600 }, (_, i) => ({ key: `f${i}`, vote: "red" as const })),
    );
    await vi.advanceTimersByTimeAsync(1200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { votes: unknown[] }).votes).toHaveLength(500);
  });
});
