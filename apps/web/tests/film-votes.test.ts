import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 红黑榜「大家的票」客户端:重点是**容错** —— 接口还没部署(404)、断网、半截响应,
// 页面都必须照常能用(退化成「大家的票为空」),绝不能把红黑榜整页拖挂。

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
const fail = (status = 404) => Promise.resolve({ ok: false, status } as unknown as Response);

/* 取整口径：全站唯一来源是 `util.ts::wholeCount`（want / screening / ticket 三个同构模块都走它）。
 * api 侧 `formatVoteCounts` 也是「一人一票的整数」，故下面第一条钉的是**真实形状行为不变**；
 * 第二条钉的是「万一上游漏了取整」时仍与另外三个模块同口径（round，而不是 trunc）。
 * 2026-09-23，PLAN-20260923113659 T7。 */
describe("取整口径（与三个同构模块同一份 wholeCount）", () => {
  it("上游真实形状（一人一票的整数）原样通过", async () => {
    const { parseVotes } = await import("../src/film-votes");
    expect(parseVotes({ a: { red: 3, black: 1 }, b: { red: "2", black: 0 } })).toEqual({
      a: { red: 3, black: 1 },
      b: { red: 2, black: 0 },
    });
  });

  it("上游漏了取整时（2.75）→ 四舍五入成 3，而不是截断成 2", async () => {
    const { parseVotes } = await import("../src/film-votes");
    expect(parseVotes({ a: { red: 2.75, black: 0 } })).toEqual({ a: { red: 3, black: 0 } });
  });
});

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

// 「服务端已确认含我」的那份快照(2026-09-23,PLAN-20260923182810)。
// 为什么单测它:它是画布扣减的**基准** —— 记错只会表现为「画布上多一枚 / 少一枚点」,
// 没有异常、没有报错,而且要等 1200ms 上报 + 重拉之后才可能自愈(用户看到的正是「过一会儿才刷新」)。
describe("synced:服务端那份 counts 里属于我的票", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("采纳一份票:红 / 黑各按一票记,同一 key 只留最后一次", async () => {
    vi.resetModules();
    const { adoptSyncedVotes, peekSyncedVotes } = await import("../src/film-votes");
    expect(peekSyncedVotes()).toEqual({});
    adoptSyncedVotes([
      { key: "a", vote: "red" },
      { key: "b", vote: "black" },
      { key: "a", vote: "black" },
    ]);
    expect(peekSyncedVotes()).toEqual({ a: { red: 0, black: 1 }, b: { red: 0, black: 1 } });
  });

  it("空表也是合法输入:它说的是「服务端那份里已经没有我了」", async () => {
    vi.resetModules();
    const { adoptSyncedVotes, peekSyncedVotes } = await import("../src/film-votes");
    adoptSyncedVotes([{ key: "a", vote: "red" }]);
    adoptSyncedVotes([]);
    expect(peekSyncedVotes()).toEqual({});
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

  it("上报成功 → 把刚发出去的这份记成「服务端已含我」,并顺手重拉一次", async () => {
    vi.resetModules();
    let reads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("film-votes-ping")) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as unknown as Response);
      }
      reads += 1;
      return okJson({ votes: { a: { red: 1, black: 0 } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { peekSyncedVotes, scheduleFilmVotesPing } = await import("../src/film-votes");

    expect(peekSyncedVotes()).toEqual({});
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });
    // 上报成功后自己那一票立刻体现在榜单上(读接口被再拉一次)
    expect(reads).toBe(1);
  });

  it("上报失败 → 不动「已同步」快照(本地保持乐观,下次成功时自愈)", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { adoptSyncedVotes, peekSyncedVotes, scheduleFilmVotesPing } = await import(
      "../src/film-votes"
    );

    adoptSyncedVotes([{ key: "a", vote: "red" }]);
    scheduleFilmVotesPing([{ key: "b", vote: "black" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });
  });
});
