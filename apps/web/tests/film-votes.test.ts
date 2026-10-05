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

describe("scheduleFilmVotesPing：发的是**增量 ops**（2026-10-05，PLAN-20261005182415 §C）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  /** 取第 `index` 次上报的载荷。 */
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, index = 0) => {
    const [, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
    return JSON.parse(String(init.body)) as {
      ops: Array<Record<string, unknown>>;
      clientId: string;
      seq: number;
      votes?: unknown;
    };
  };

  it("★ 1200ms 防抖：窗口内多次调用只发一条，同一部片以最后一次为准；载荷里**没有** `votes`", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
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
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/stats/film-votes-ping");

    const body = bodyOf(fetchMock);
    // ⚠ 整份替换那个 `votes` 字段**不再出现** —— 这正是 §C 换掉的东西
    expect(body).not.toHaveProperty("votes");
    expect(body.seq).toBe(1);
    expect(typeof body.clientId).toBe("string");
    expect(body.ops).toEqual([
      { op: "set", key: "a", vote: "black", comment: null, skin: null },
      { op: "set", key: "b", vote: "red", comment: null, skin: null },
    ]);
    // ⚠ 防抖窗口内那次改动**被合并掉**了（同一部片只发最后一条）而不是排队两条
    expect(init.method).toBe("POST");
  });

  it("★ 只发改动过的那几部片 —— 第二次上报只有新增那一条（这才是「增量」）", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(bodyOf(fetchMock, 0).ops).toHaveLength(1);

    // 第二次：a 没变、b 是新贴的 → 只该发 b
    scheduleFilmVotesPing([
      { key: "a", vote: "red" },
      { key: "b", vote: "red" },
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).ops).toEqual([
      { op: "set", key: "b", vote: "red", comment: null, skin: null },
    ]);
    // 批次号逐批发（服务端的水位靠它挡重放 / 乱序）
    expect(bodyOf(fetchMock, 0).seq).toBe(1);
    expect(bodyOf(fetchMock, 1).seq).toBe(2);
  });

  it("★ 撤回一部片 → 一条 `remove` op（而不是「服务端替我删掉其余的」）", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([
      { key: "a", vote: "red" },
      { key: "b", vote: "black" },
    ]);
    await vi.advanceTimersByTimeAsync(1200);

    scheduleFilmVotesPing([{ key: "b", vote: "black" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(bodyOf(fetchMock, 1).ops).toEqual([{ op: "remove", key: "a" }]);
  });

  // 评语 / 款字段（2026-09-29 / 2026-10-05）。
  // ⚠ 对 op 来说这条要求**更强**：服务端把 `set` 当成「这部片现在是这个状态」整条覆盖 ——
  //   省掉 `comment` 等于告诉它「这部片没有评语」，那不是用户的意思（他刚改的是颜色）。
  it("★ `set` op 里 comment / skin **必须在**：没写评语时补 null，脏值也归成 null", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([
      { key: "a", vote: "red" },
      { key: "b", vote: "black", comment: "好看", skin: "sprocket" },
      { key: "c", vote: "red", skin: "not-a-skin" as never },
    ]);
    await vi.advanceTimersByTimeAsync(1200);

    const ops = bodyOf(fetchMock).ops;
    expect(ops).toEqual([
      { op: "set", key: "a", vote: "red", comment: null, skin: null },
      { op: "set", key: "b", vote: "black", comment: "好看", skin: "sprocket" },
      { op: "set", key: "c", vote: "red", comment: null, skin: null },
    ]);
    for (const op of ops) {
      expect("comment" in op).toBe(true);
      expect("skin" in op).toBe(true);
    }
  });

  it("★ 盘上什么都没有时（新装设备）第一次调度把**整面墙**发上去（换设备 / 清 cookie 的自愈）", async () => {
    vi.resetModules();
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([
      { key: "a", vote: "red" },
      { key: "b", vote: "black" },
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    // ⚠ 整面墙 —— 否则「本地有、服务端没有」的票永远上不去（A 那版靠整份替换兜住，现在靠这条）
    expect(bodyOf(fetchMock).ops.map((op) => op.key)).toEqual(["a", "b"]);
  });

  it("★ 超过单批上限时**切片**发：每片一个批次号，一条都不丢（与整份替换的「累积前缀」相反）", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, MAX_VOTES_PER_PING } = await import("../src/film-votes");

    expect(MAX_VOTES_PER_PING).toBe(500);
    scheduleFilmVotesPing(
      Array.from({ length: MAX_VOTES_PER_PING + 3 }, (_, index) => ({
        key: `f${index}`,
        vote: "red" as const,
      })),
    );
    await vi.advanceTimersByTimeAsync(1200);
    // 第二片是在第一片 await 之后才发起的 —— 再走一轮把它的微任务放出来
    await vi.advanceTimersByTimeAsync(0);

    const sizes = fetchMock.mock.calls.map((_, index) => bodyOf(fetchMock, index).ops.length);
    // ⚠ 不能像整份替换那样发「累积前缀」（那会把后一片盖掉）：两片互不相交，合起来才是全部
    expect(sizes).toEqual([MAX_VOTES_PER_PING, 3]);
    expect(bodyOf(fetchMock, 0).seq).toBe(1);
    expect(bodyOf(fetchMock, 1).seq).toBe(2);
  });

  it("上报成功 → 采纳服务端回的 counts，并把「服务端已含我」的基准切成 base", async () => {
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: { a: { red: 3, black: 0 } }, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { peekFilmVotes, peekSyncedVotes, scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);

    expect(peekFilmVotes()).toEqual({ a: { red: 3, black: 0 } });
    // ⚠ 扣减基准仍要切到「服务端已含我」那份，否则画布上会多画一枚别人的点
    expect(peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });
  });

  it("服务端不认增量（响应里没有 votes）→ 退回去重拉一次", async () => {
    vi.resetModules();
    let reads = 0;
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes("film-votes-ping")) return okJson({ ok: true });
      reads += 1;
      return okJson({ votes: { a: { red: 1, black: 0 } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { peekFilmVotes, scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(reads).toBe(1);
    expect(peekFilmVotes()).toEqual({ a: { red: 1, black: 0 } });
  });

  it("连续失败会通知订阅者(1、2…)，成功一次就报 0 让它复位", async () => {
    vi.resetModules();
    let ok = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (ok ? okJson({ ok: true, votes: {}, skins: {} }) : fail(500))),
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
    // 成功 → 报一次 0（视图层据此把「已经提示过」复位，下次再失败才会再说一次）
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
    scheduleFilmVotesPing([{ key: "a", vote: "black" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(kinds).toEqual(["rejected", "offline"]);
  });
});

/* ---------------- 增量 op 的两个纯函数（口径最容易被改坏的地方） ---------------- */

describe("planVoteOps / coalesceOps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const payload = (
    key: string,
    vote: "red" | "black",
    comment: string | null = null,
    skin: "stub" | "scrap" | "sprocket" | null = null,
  ) => ({ key, vote, comment, skin });

  it("★ 没变的片不发；新片是 set；消失的片是 remove", async () => {
    const { planVoteOps } = await import("../src/film-votes");
    const base = [payload("a", "red"), payload("b", "black"), payload("c", "red")];
    const board = [payload("a", "red"), payload("b", "red"), payload("d", "black")];
    expect(planVoteOps(base, board)).toEqual([
      { op: "set", key: "b", vote: "red", comment: null, skin: null },
      { op: "set", key: "d", vote: "black", comment: null, skin: null },
      { op: "remove", key: "c" },
    ]);
  });

  it("评语 / 款的改动也算「变了」（否则用户写了评语永远同步不上去）", async () => {
    const { planVoteOps } = await import("../src/film-votes");
    const base = [payload("a", "red")];
    expect(planVoteOps(base, [payload("a", "red", "好看")])).toEqual([
      { op: "set", key: "a", vote: "red", comment: "好看", skin: null },
    ]);
    expect(planVoteOps(base, [payload("a", "red", null, "stub")])).toEqual([
      { op: "set", key: "a", vote: "red", comment: null, skin: "stub" },
    ]);
  });

  it("★ 合并同一部片的多条 op：只留最后一条（载荷才塞得进 keepalive）", async () => {
    const { coalesceOps } = await import("../src/film-votes");
    const merged = coalesceOps(
      [
        { op: "set", key: "a", vote: "red", comment: null, skin: null },
        { op: "set", key: "b", vote: "black", comment: null, skin: null },
      ],
      [
        { op: "set", key: "a", vote: "black", comment: null, skin: null },
        { op: "remove", key: "b" },
      ],
    );
    expect(merged).toEqual([
      { op: "set", key: "a", vote: "black", comment: null, skin: null },
      { op: "remove", key: "b" },
    ]);
  });
});

/* ---------------- 待发队列（§A 的落盘 + §C 的增量形状） ---------------- */

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
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return { mock, resolvers };
}

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

  it("★ 落盘的是「设备标识 + 批次号 + 差分基准 + 待发 op」（键在 `iffday.workspace.*`）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { scheduleFilmVotesPing, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");

    expect(LS_PENDING_FILM_VOTES.startsWith("iffday.workspace.")).toBe(true);
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);

    const stored = JSON.parse(storage.getItem(LS_PENDING_FILM_VOTES)!) as {
      clientId: string;
      seq: number;
      base: unknown[];
      ops: unknown[];
    };
    expect(stored.seq).toBe(0);
    expect(typeof stored.clientId).toBe("string");
    // `base` 是「队列里那些 op 全落地之后」的那面墙 —— 下一次差分靠它
    expect(stored.base).toEqual([{ key: "a", vote: "red", comment: null, skin: null }]);
    expect(stored.ops).toEqual([{ op: "set", key: "a", vote: "red", comment: null, skin: null }]);
  });

  it("★ 下一次载入先把它补发掉，成功后队列清空（关了页面也补得上）", async () => {
    // 第一次载入：改了票、落了盘，但页面在 1200ms 内就走了（上报从没发生）
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { scheduleFilmVotesPing, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    expect(storage.getItem(LS_PENDING_FILM_VOTES)).not.toBeNull();

    // 第二次载入（等价于刷新 / 重开标签页）
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: { a: { red: 3, black: 0 } }, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/film-votes");
    mod.resumePendingFilmVotes();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      ops: unknown[];
      seq: number;
    };
    expect(body.ops).toEqual([{ op: "set", key: "a", vote: "red", comment: null, skin: null }]);
    expect(body.seq).toBe(1);
    expect(mod.peekSyncedVotes()).toEqual({ a: { red: 1, black: 0 } });

    // 确认之后：队列空、水位记到 1（`base` 留着当下一次的差分基准）
    const stored = JSON.parse(storage.getItem(LS_PENDING_FILM_VOTES)!) as {
      seq: number;
      ops: unknown[];
    };
    expect(stored.seq).toBe(1);
    expect(stored.ops).toEqual([]);
  });

  it("盘上没有待发 → 载入时**什么都不做**（没有 ops 就没有意图）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => okJson({ votes: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/film-votes");

    mod.resumePendingFilmVotes();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ 盘上那一份认不全就**整份丢弃**（丢一条 op = 那次改动静默没了，而且永远补不回来）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { resumePendingFilmVotes, LS_PENDING_FILM_VOTES } = await import("../src/film-votes");

    for (const raw of [
      "not json",
      JSON.stringify({ seq: 1, base: [], ops: [] }), // 缺 clientId
      JSON.stringify({ clientId: "c", seq: "1", base: [], ops: [] }), // seq 不是数字
      JSON.stringify({ clientId: "c", seq: 1, base: [{ key: "a", vote: "green" }], ops: [] }),
      JSON.stringify({ clientId: "c", seq: 1, base: [], ops: [{ op: "set", key: "a", vote: "green" }] }),
      JSON.stringify({ clientId: "c", seq: 1, base: [], ops: [{ op: "nope", key: "a" }] }),
    ]) {
      storage.setItem(LS_PENDING_FILM_VOTES, raw);
      resumePendingFilmVotes();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("§A 那个旧键（整份票）会被清掉 —— 它那一票仍会以 `set` op 重发（base 从空开始）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    storage.setItem(
      "iffday.workspace.redblackpending.v1",
      JSON.stringify({ seq: 3, votes: [{ key: "a", vote: "red" }] }),
    );
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { resumePendingFilmVotes, scheduleFilmVotesPing } = await import("../src/film-votes");

    resumePendingFilmVotes();
    expect(storage.getItem("iffday.workspace.redblackpending.v1")).toBeNull();

    // 旧键里那一票仍在本地 board 里 → 新键的 base 从空开始 ⇒ 下一次调度把整面墙发上去
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      ops: unknown[];
    };
    expect(body.ops).toEqual([{ op: "set", key: "a", vote: "red", comment: null, skin: null }]);
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

  it("★ `pagehide` 与 `visibilitychange(hidden)` 两个监听都挂上，且发的是 keepalive", async () => {
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      okJson({ ok: true, votes: {}, skins: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing } = await import("../src/film-votes");

    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    fetchMock.mockClear();

    // 切到后台（iOS 上切 App 走的是这条）→ keepalive 最后一发
    doc.visibilityState = "hidden";
    docHandlers.get("visibilitychange")!();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      seq: 1,
      ops: [{ op: "set", key: "a" }],
    });

    // 关标签页 / 被系统回收 → 也发（队列已空则什么都不做）
    // ⚠ 先放掉上一发的微任务：确认是异步跑的，不等它就会看到队列还没清
    await vi.advanceTimersByTimeAsync(0);
    winHandlers.get("pagehide")!();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("★ 载荷超过 64KB 时**不发**（留盘下次补）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, sendFilmVotesKeepalive, KEEPALIVE_BODY_LIMIT } = await import(
      "../src/film-votes"
    );

    // 500 部片 × 每条一大段评语 → 远超 64KB，但**没超**单次条数上限
    scheduleFilmVotesPing(
      Array.from({ length: 500 }, (_, index) => ({
        key: `f${index}`,
        vote: "red" as const,
        comment: "这是一段很长的评语".repeat(20),
      })),
    );
    expect(KEEPALIVE_BODY_LIMIT).toBe(64 * 1024);
    expect(sendFilmVotesKeepalive()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // ⚠ 没发出去 ≠ 丢掉：盘上那份还在，下次开页面照旧补发
    expect(storage.length).toBeGreaterThan(0);
  });

  it("超过单批上限（一片发不完）时 keepalive **不发**（切片会丢后半截）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => fail());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduleFilmVotesPing, sendFilmVotesKeepalive, MAX_VOTES_PER_PING } = await import(
      "../src/film-votes"
    );

    scheduleFilmVotesPing(
      Array.from({ length: MAX_VOTES_PER_PING + 1 }, (_, index) => ({
        key: `g${index}`,
        vote: "red" as const,
      })),
    );
    expect(sendFilmVotesKeepalive()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ 在途时又改了票：keepalive 发的是**更新**那一份，旧响应被丢弃（不把新状态盖回去）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("window", { addEventListener: () => undefined });
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: () => undefined,
    };
    vi.stubGlobal("document", doc);
    const { mock, resolvers } = deferredFetches();
    vi.stubGlobal("fetch", mock);
    const { scheduleFilmVotesPing, sendFilmVotesKeepalive, peekSyncedVotes, peekFilmVotes } =
      await import("../src/film-votes");

    // 第 1 批（seq 1）：发出去，挂在半空
    scheduleFilmVotesPing([{ key: "a", vote: "red" }]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(resolvers).toHaveLength(1);

    // 用户手快，又改了（seq 2）—— 它走 keepalive 那条路（不等响应、不占在途位）
    scheduleFilmVotesPing([{ key: "a", vote: "black" }]);
    expect(sendFilmVotesKeepalive()).toBe(true);
    resolvers[1]({
      ok: true,
      json: async () => ({ ok: true, votes: { a: { red: 0, black: 9 } }, skins: {} }),
    } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(peekSyncedVotes()).toEqual({ a: { red: 0, black: 1 } });
    expect(peekFilmVotes()).toEqual({ a: { red: 0, black: 9 } });

    // 现在**旧**那批（seq 1）才回来：整条丢弃（它的 op 是旧值，采纳它等于把黑改回红）
    resolvers[0]({
      ok: true,
      json: async () => ({ ok: true, votes: { a: { red: 1, black: 0 } }, skins: {} }),
    } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(peekSyncedVotes()).toEqual({ a: { red: 0, black: 1 } });
    expect(peekFilmVotes()).toEqual({ a: { red: 0, black: 9 } });
  });

  it("keepalive 失败**不清队列**（拿不到响应就等于没确认，留着下次补）", async () => {
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
    const stored = JSON.parse(storage.getItem(LS_PENDING_FILM_VOTES)!) as { ops: unknown[] };
    expect(stored.ops).toHaveLength(1);
  });
});

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

  it("★ 失败后自己重试，而且 payload **逐字不变**（重发的是同一批 op）", async () => {
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

    const bodies = fetchMock.mock.calls
      .map(([, init]) => String((init as RequestInit).body))
      .map((body) => body.replace(/"seq":\d+/, '"seq":0'));
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
  //   于是被限流的那一批只能等下一次改动（或下次开页面的补发）才补上。
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
