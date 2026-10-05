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

// 按款分布（2026-09-29，PLAN-20260929195500）。它只决定**群点长什么样**，
// 所以坏数据不能让它抛错；但也**不能猜** —— 猜出来的群点会理直气壮地错。
describe("parseFilmSkins 白名单", () => {
  it("★ 不认识的款**整条丢掉**，而不是回退成某一款", async () => {
    const { parseFilmSkins } = await import("../src/film-votes");
    expect(
      parseFilmSkins({
        a: { stub: { red: 2, black: 1 }, "not-a-skin": { red: 9, black: 9 } },
      }),
    ).toEqual({ a: { stub: { red: 2, black: 1 } } });
    // 整部片的款都不认识 → 这一部干脆不进表（画布走「按 id 兜底」）
    expect(parseFilmSkins({ a: { nope: { red: 1, black: 0 } } })).toEqual({});
  });

  it("计数照 `wholeCount` 同一口径：字符串数字认、负数夹回 0、全 0 的桶不输出", async () => {
    const { parseFilmSkins } = await import("../src/film-votes");
    expect(
      parseFilmSkins({
        a: { stub: { red: "2", black: -5 }, sprocket: { red: 0, black: 0 } },
      }),
    ).toEqual({ a: { stub: { red: 2, black: 0 } } });
  });

  it("非对象 / 缺字段 / 半截响应一律当没有，不抛错", async () => {
    const { parseFilmSkins } = await import("../src/film-votes");
    expect(parseFilmSkins(undefined)).toEqual({});
    expect(parseFilmSkins(null)).toEqual({});
    expect(parseFilmSkins("nope")).toEqual({});
    expect(parseFilmSkins({ a: null, b: "nope", c: { stub: null } })).toEqual({});
  });
});

describe("loadFilmVotes 会把按款分布一起收下", () => {
  it("★ 与两色总数在**同一次**响应里到达（分两个接口会多一次 RTT、还可能差一拍）", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        okJson({
          edition: "biff-2026",
          votes: { a: { red: 2, black: 0 } },
          skins: { a: { stub: { red: 1, black: 0 } } },
        }),
      ),
    );
    const { loadFilmVotes, peekFilmSkins, peekFilmVotes } = await import("../src/film-votes");
    await loadFilmVotes();
    expect(peekFilmVotes()).toEqual({ a: { red: 2, black: 0 } });
    expect(peekFilmSkins()).toEqual({ a: { stub: { red: 1, black: 0 } } });
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
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

  // 评语字段(2026-09-29,PLAN-20260929181900)。
  // 为什么单测它:服务端靠「这一份里有没有 `comment` 字段」分辨新版 / 旧版前端 ——
  // **一条都没带**时它一个字都不碰评语列(老客户端的一次普通上报不能静默清空用户写过的评语)。
  // 反过来说:新版前端要是漏了字段,评语就**永远写不进去**,而且服务端不报错。
  it("每一条都带 comment 字段:没有评语时补 null,不是省略", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => okJson({ ok: true, votes: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    // 只给 {key, vote}(老调用形状)→ 也要补成 null
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    // 给了评语 → 原样带上
    scheduleFilmVotesPing([
      { key: "a", vote: "red", comment: "好看" },
      { key: "b", vote: "black" },
    ]);
    await vi.advanceTimersByTimeAsync(1200);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const votes = (JSON.parse(String(init.body)) as { votes: Array<Record<string, unknown>> })
      .votes;
    expect(votes).toEqual([
      { key: "a", vote: "red", comment: "好看", skin: null },
      { key: "b", vote: "black", comment: null, skin: null },
    ]);
    for (const entry of votes) expect("comment" in entry).toBe(true);
  });

  // 贴纸款字段(2026-09-29,PLAN-20260929195500)。**与 `comment` 逐字同一条规矩**:
  // 服务端靠「这一份里有没有 `skin` 字段」分辨新版 / 旧版前端 —— 一条都没带时它一个字都不碰
  // 款列(老客户端的一次普通上报不能把用户选过的款静默抹掉);反过来说新版前端漏了字段,
  // 用户选的那款就**永远同步不上去**,而且服务端不报错。
  it("每一条都带 skin 字段:没选款时补 null、脏值也归成 null,而不是省略", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(() => okJson({ ok: true, votes: {}, skins: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([
      // 没给款(老调用形状)→ 补 null
      { key: "a", vote: "red" },
      // 给了款 → 原样带上
      { key: "b", vote: "black", skin: "sprocket" },
      // 脏值(不在契约层白名单里)→ 归成 null,而不是把它发上去让服务端丢整条
      { key: "c", vote: "red", skin: "not-a-skin" as never },
    ]);
    await vi.advanceTimersByTimeAsync(1200);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const votes = (JSON.parse(String(init.body)) as { votes: Array<Record<string, unknown>> })
      .votes;
    expect(votes).toEqual([
      { key: "a", vote: "red", comment: null, skin: null },
      { key: "b", vote: "black", comment: null, skin: "sprocket" },
      { key: "c", vote: "red", comment: null, skin: null },
    ]);
    for (const entry of votes) expect("skin" in entry).toBe(true);
  });

  it("超过上限不丢票:按**累积前缀**分批,最后一批才是全量(服务端是整份替换语义)", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => okJson({ ok: true, votes: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, MAX_VOTES_PER_PING } = await import("../src/film-votes");

    expect(MAX_VOTES_PER_PING).toBe(500);
    scheduleFilmVotesPing(
      Array.from({ length: 600 }, (_, i) => ({ key: `f${i}`, vote: "red" as const })),
    );
    await vi.advanceTimersByTimeAsync(1200);
    // 第二批是在第一批 await 之后才发起的 —— 再走一轮把它的微任务放出来
    await vi.advanceTimersByTimeAsync(0);

    // ⚠ 为什么不是 [500, 100]:服务端按**整份替换**,切成互不相交的两块会让后一块把前一块盖掉,
    // 等于只发了最后 100 条(那正是原来的静默丢票)。所以第 1 批发前 500、第 2 批发**全部 600**。
    const sizes = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { votes: unknown[] }).votes.length,
    );
    expect(sizes).toEqual([500, 600]);
  });

  it("服务端在 ping 响应里顺手回了全量 → 直接用,不再重拉一次(省掉一个 RTT)", async () => {
    vi.resetModules();
    let reads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("film-votes-ping")) {
        return okJson({ ok: true, count: 1, votes: { a: { red: 3, black: 0 } } });
      }
      reads += 1;
      return okJson({ votes: { a: { red: 1, black: 0 } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { peekFilmVotes, peekSyncedVotes, scheduleFilmVotesPing } = await import(
      "../src/film-votes"
    );

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);

    expect(reads).toBe(0);
    expect(peekFilmVotes()).toEqual({ a: { red: 3, black: 0 } });
    // ⚠ 扣减基准仍要切到「服务端已含我」那份,否则画布上会多画一枚别人的点
    expect(peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });
  });

  it("连续失败会通知订阅者(1、2…),成功一次就报 0 让它复位", async () => {
    vi.resetModules();
    let ok = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (ok ? okJson({ ok: true }) : fail(500))),
    );
    const { onFilmVotesPingFailure, scheduleFilmVotesPing } = await import("../src/film-votes");
    const seen: number[] = [];
    onFilmVotesPingFailure((streak) => seen.push(streak));

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(seen).toEqual([1]);

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(seen).toEqual([1, 2]);

    ok = true;
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    // 成功 → 报一次 0(视图层据此把「已经提示过」复位,下次再失败才会再说一次)
    expect(seen).toEqual([1, 2, 0]);
  });

  // 2026-09-30:那次线上事故里每一次上报都被服务端 422 拒掉,而提示一直在说「请检查网络后重试」——
  // 把人往错的方向带了整整一天。所以「服务端拒绝」与「请求压根没走通」必须分开报。
  it("失败的**种类**一起报出来：服务端拒绝（非 2xx）≠ 网络不通", async () => {
    vi.resetModules();
    let rejected = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (rejected ? fail(422) : Promise.reject(new Error("offline")))),
    );
    const { onFilmVotesPingFailure, scheduleFilmVotesPing } = await import("../src/film-votes");
    const kinds: Array<string | null> = [];
    onFilmVotesPingFailure((_streak, kind) => kinds.push(kind));

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(kinds).toEqual(["rejected"]);

    rejected = false;
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(kinds).toEqual(["rejected", "offline"]);
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
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

/* ---------------- 待发队列 / 关页补发 / 退避重试（2026-10-05，PLAN-20261005182415 §A） ----------------
 *
 * 由来（每一条都对应一个服务端能观测到的丢票症状）：
 *   · 上报原来只活在一个 1200ms 的 `setTimeout` 闭包里 —— 关页 / 切后台 / 崩溃就**从来没发出去**
 *     （服务端：贡献表里根本没有这一票）；
 *   · 失败之后不重试，只靠「下次票签名变了」碰巧自愈 —— 而拖动不改签名，补不上。
 * 这几条测试钉的就是上面两件事：**那一份票必须留在盘上、必须有人把它发出去**。 */

/** node 环境没有 localStorage；用手写的假实现（模块只在函数里读它，所以 stub 时机不敏感）。 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  } as Storage;
}

/** 可控的 fetch：把「第几次调用」的 resolver 攥在手里，用来造「在途时又改了票」这种时序。 */
function deferredFetches() {
  const resolvers: Array<(value: Response) => void> = [];
  const mock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return { mock, resolvers };
}

describe("退避重试：序列与「哪些失败不该重试」", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("退避序列是 1s → 2s → 4s → 8s → 16s → 30s(封顶)", async () => {
    vi.resetModules();
    const { pingRetryDelay } = await import("../src/film-votes");
    expect([0, 1, 2, 3, 4, 5, 6].map(pingRetryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it("★ 失败后自己重试,而且 payload **逐字不变**（服务端是整份替换，不能越重试越少）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let calls = 0;
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
      calls += 1;
      return calls <= 2 ? fail(500) : okJson({ ok: true, votes: {}, skins: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // 第 1 次退避
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000); // 第 2 次退避 → 这一次成功
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 成功之后不再重试
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(bodies).size).toBe(1);
  });

  it("4xx 不重试（服务端拒绝是载荷 / 版本问题，重试一万次也不会好）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn(() => fail(422));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ⚠ 断言的是**当前口径**（用户：4xx 一律不重试），而它有已知代价：**限流 429 也算 4xx**，
  //   于是被限流的那一票只能等下一次票签名变化（或下次开页面的补发）才补上。
  //   见 PLAN-20261005182415 §A 的「已知取舍」；判据收在 `shouldRetryPing` 一处。
  it("（已知代价）429 也归在「不重试」里 —— 改它只需改 `shouldRetryPing` 一行", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn(() => fail(429));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, shouldRetryPing, FilmVotesPingRejectedError } = await import(
      "../src/film-votes"
    );

    expect(shouldRetryPing(new FilmVotesPingRejectedError(429))).toBe(false);
    expect(shouldRetryPing(new FilmVotesPingRejectedError(500))).toBe(true);
    expect(shouldRetryPing(new Error("offline"))).toBe(true);

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200 + 120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("待发队列：关页 / 切后台 / 崩溃都不丢", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("★ 「要发的那一份」落盘（键在 `iffday.workspace.*` —— 不能被账号同步带走）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { scheduleFilmVotesPing, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");

    expect(LS_PENDING_FILM_VOTES.startsWith("iffday.workspace.")).toBe(true);
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);

    const stored = JSON.parse(storage.getItem(LS_PENDING_FILM_VOTES)!);
    expect(stored.seq).toBe(1);
    expect(stored.votes).toEqual([{ key: "a", vote: "red", comment: null, skin: null }]);
  });

  it("★ 下一次载入先把它补发掉，成功后清盘（关了页面也补得上）", async () => {
    // 第一次载入：改了票、落了盘，但页面在 1200ms 内就走了（上报从没发生）
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { scheduleFilmVotesPing, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    expect(storage.getItem(LS_PENDING_FILM_VOTES)).not.toBeNull();

    // 第二次载入（等价于刷新 / 重开标签页）
    vi.resetModules();
    const fetchMock = vi.fn(() => okJson({ ok: true, votes: { a: { red: 3, black: 0 } }, skins: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/film-votes");
    mod.resumePendingFilmVotes();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      votes: [{ key: "a", vote: "red" }],
    });
    expect(storage.getItem(LS_PENDING_FILM_VOTES)).toBeNull();
    expect(mod.peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });

    // ⚠ 序号要接着盘上那一份往下走：否则新一轮的 seq 会比盘上那份还小，
    //   `seq` 守卫会把**更新的**响应当成旧的丢掉。
    mod.scheduleFilmVotesPing([{ key: "b", vote: "black" }]);
    expect(JSON.parse(storage.getItem(LS_PENDING_FILM_VOTES)!).seq).toBe(2);
  });

  it("盘上没有待发 → 载入时**什么都不做**（本地为空 ≠ 我撤票了，拿空榜上报会清掉服务端的票）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn(() => okJson({ votes: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/film-votes");

    mod.resumePendingFilmVotes();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空表是**合法**的待发（我撤回了全部票，那一次也得补发）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { resumePendingFilmVotes, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");
    storage.setItem(LS_PENDING_FILM_VOTES, JSON.stringify({ seq: 1, votes: [] }));

    resumePendingFilmVotes();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).votes).toEqual([]);
  });

  it("★ 盘上那一份认不全就**整份丢弃**（丢掉一条 = 把那一票当成「用户撤回了」，是破坏性的）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn(() => okJson({ ok: true, votes: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { resumePendingFilmVotes, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");

    for (const raw of [
      "not json",
      JSON.stringify({ votes: [] }), // 没有 seq → 分不清「脏数据」与「我撤回了全部票」
      JSON.stringify({ seq: 1, votes: "nope" }),
      JSON.stringify({ seq: 1, votes: [{ key: "a", vote: "green" }] }),
      JSON.stringify({ seq: 1, votes: [{ key: "", vote: "red" }] }),
    ]) {
      storage.setItem(LS_PENDING_FILM_VOTES, raw);
      resumePendingFilmVotes();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("关页那一发：keepalive 与它的两条硬约束", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("★ `pagehide` 与 `visibilitychange(hidden)` 两个监听都挂上（少一个就有一整类场景不补发）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const winHandlers = new Map<string, () => void>();
    const docHandlers = new Map<string, () => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (type: string, listener: () => void) => docHandlers.set(type, listener),
    };
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => winHandlers.set(type, listener),
    });
    vi.stubGlobal("document", doc);
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    fetchMock.mockClear();

    // 切到后台（iOS 上切 App 走的是这条）→ keepalive 最后一发
    doc.visibilityState = "hidden";
    docHandlers.get("visibilitychange")!();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);

    // 回到前台 → 再补一次（它可能压根没发出去过）。⚠ 这一发**不是** keepalive：
    //   页面还活着，要拿得到响应才能清 pending。
    doc.visibilityState = "visible";
    docHandlers.get("visibilitychange")!();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).keepalive).toBeUndefined();

    // 关标签页 / 被系统回收 → 也发
    winHandlers.get("pagehide")!();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as RequestInit).keepalive).toBe(true);
  });

  it("退避计时器正等着的时候，回到前台**不插队**（否则退避被白白抵消）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const docHandlers = new Map<string, () => void>();
    const doc = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener: (type: string, listener: () => void) => docHandlers.set(type, listener),
    };
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", doc);
    const fetchMock = vi.fn(() => fail(500));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200); // 正常那一发失败 → 退避计时器已经挂上
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    doc.visibilityState = "visible";
    docHandlers.get("visibilitychange")!();
    expect(fetchMock).not.toHaveBeenCalled(); // 交给退避计时器，不插队

    await vi.advanceTimersByTimeAsync(1000); // 退避到点 → 由它发
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("★ 载荷超过 64KB 时**不发**（整份替换语义下，截断载荷会把其余票删掉）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
    vi.stubGlobal("fetch", fetchMock);
    const {
      scheduleFilmVotesPing,
      sendFilmVotesKeepalive,
      KEEPALIVE_BODY_LIMIT,
      MAX_VOTES_PER_PING,
    } = await import("../src/film-votes");

    // 500 部片 × 每条一大段评语 → 远超 64KB，但**没超**单次条数上限
    scheduleFilmVotesPing(
      Array.from({ length: MAX_VOTES_PER_PING }, (_, i) => ({
        key: `f${i}`,
        vote: "red" as const,
        comment: "这是一段很长的评语".repeat(20),
      })),
    );
    expect(KEEPALIVE_BODY_LIMIT).toBe(64 * 1024);
    expect(sendFilmVotesKeepalive()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // ⚠ 没发出去 ≠ 丢掉：盘上那份还在，下次开页面照旧补发
    expect(storage.length).toBeGreaterThan(0);

    // 超过单次条数上限（一份发不完）→ 同样不发
    scheduleFilmVotesPing(
      Array.from({ length: MAX_VOTES_PER_PING + 1 }, (_, i) => ({ key: `g${i}`, vote: "red" as const })),
    );
    expect(sendFilmVotesKeepalive()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ 在途时又改了票：旧响应被丢弃，不被它盖回去（「刚收回的贴纸又冒出来」）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    const doc = { visibilityState: "visible" as DocumentVisibilityState, addEventListener: () => undefined };
    vi.stubGlobal("document", doc);
    const { mock, resolvers } = deferredFetches();
    vi.stubGlobal("fetch", mock);
    const { scheduleFilmVotesPing, sendFilmVotesKeepalive, peekSyncedVotes, peekFilmVotes } =
      await import("../src/film-votes");

    // 第 1 份（seq 1）：发出去，挂在半空
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(resolvers).toHaveLength(1);

    // 用户手快，又改了一次（seq 2）—— 它走 keepalive 那条路（不等响应、不占在途位）
    scheduleFilmVotesPing([{ key: "a", vote: "black" }]);
    expect(sendFilmVotesKeepalive()).toBe(true);
    resolvers[1]({
      ok: true,
      json: async () => ({ ok: true, votes: { a: { red: 0, black: 9 } }, skins: {} }),
    } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(peekSyncedVotes()).toEqual({ a: { red: 0, black: 1 } });
    expect(peekFilmVotes()).toEqual({ a: { red: 0, black: 9 } });

    // 现在**旧**那条（seq 1）才回来：它的 counts 更旧，必须整条丢弃
    resolvers[0]({
      ok: true,
      json: async () => ({ ok: true, votes: { a: { red: 1, black: 0 } }, skins: {} }),
    } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(peekSyncedVotes()).toEqual({ a: { red: 0, black: 1 } });
    expect(peekFilmVotes()).toEqual({ a: { red: 0, black: 9 } });
  });

  it("失败那一发**不清盘**（拿不到响应就等于没确认，留着下次补）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const { scheduleFilmVotesPing, sendFilmVotesKeepalive, LS_PENDING_FILM_VOTES } = await import(
      "../src/film-votes"
    );

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    expect(sendFilmVotesKeepalive()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.getItem(LS_PENDING_FILM_VOTES)).not.toBeNull();
  });
});
