// 红黑榜「大家说」评语客户端(2026-09-29,PLAN-20260929181900)。
//
// 为什么单测它:三条判据错了都不会报错,只会「看起来少了几行」——
//   ① 白名单太松 → 半截响应里的坏行渲染成空白的一行;
//   ② 游标 / 去重错 → 「加载更多」把同一页追加两遍(或一次失败之后再也翻不动);
//   ③ 失败没有降级 → 接口没上线时整页崩,而评语只是附加内容。
//
// 模块状态是模块级的,所以每条用例走 `vi.resetModules()` + 动态 import(与 `film-votes.test.ts` 同一手法)。

import { afterEach, describe, expect, it, vi } from "vitest";

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
const fail = (status = 404) => Promise.resolve({ ok: false, status } as unknown as Response);

function line(
  filmKey: string,
  comment: string,
  options: { vote?: "red" | "black"; displayName?: string | null } = {},
) {
  return {
    filmKey,
    vote: options.vote ?? "red",
    comment,
    displayName: options.displayName ?? null,
  };
}

const page = (items: unknown[], nextCursor: unknown = null) => ({
  edition: "biff-2026",
  items,
  nextCursor,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("parseCommentItems 白名单", () => {
  it("丢掉形状非法的行,只留能渲染的(缺正文 / 非法 vote / 空片名)", async () => {
    const { parseCommentItems } = await import("../src/film-comments");
    expect(
      parseCommentItems([
        line("a", "好看"),
        { filmKey: "b", vote: "blue", comment: "x" },
        { filmKey: "c", vote: "red", comment: "   " },
        { filmKey: "", vote: "red", comment: "x" },
        // 昵称是空白 → 当「匿名观众」(null),而不是渲染一行空白昵称
        line("d", "稳", { vote: "black", displayName: "   " }),
        null,
        "nope",
      ]),
    ).toEqual([
      { filmKey: "a", vote: "red", comment: "好看", displayName: null },
      { filmKey: "d", vote: "black", comment: "稳", displayName: null },
    ]);
    expect(parseCommentItems(null)).toEqual([]);
    expect(parseCommentItems({ nope: true })).toEqual([]);
  });

  it("nextCursor 非字符串 / 空串一律当「没有下一页」", async () => {
    const { parseCommentsPage } = await import("../src/film-comments");
    expect(parseCommentsPage(page([], "OPAQUE")).nextCursor).toBe("OPAQUE");
    expect(parseCommentsPage(page([], "")).nextCursor).toBeNull();
    expect(parseCommentsPage(page([], 42)).nextCursor).toBeNull();
    expect(parseCommentsPage(null)).toEqual({ items: [], nextCursor: null });
  });
});

describe("loadFilmComments:一页的请求形状", () => {
  it("游标**原样回传**(前端不解析、不自己拼),并按 edition + limit 请求", async () => {
    const fetchMock = vi.fn((_url: string) => okJson(page([line("a", "好看")], "OPAQUE-1")));
    vi.stubGlobal("fetch", fetchMock);
    const { loadFilmComments } = await import("../src/film-comments");

    const result = await loadFilmComments({ cursor: "OPAQUE-0" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/api/stats/film-comments");
    expect(url).toContain("edition=biff-2026");
    expect(url).toContain("cursor=OPAQUE-0");
    expect(result.items).toEqual([
      { filmKey: "a", vote: "red", comment: "好看", displayName: null },
    ]);
    expect(result.nextCursor).toBe("OPAQUE-1");
  });

  it("失败(404 / 500 / 断网)→ 空页,不抛(接口没上线时页面照常可用)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { loadFilmComments } = await import("../src/film-comments");
    await expect(loadFilmComments()).resolves.toEqual({ items: [], nextCursor: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await expect(loadFilmComments()).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe("分页:第一页幂等 + 加载更多按游标追加", () => {
  it("第一页只取一次;force 时重头来过", async () => {
    const fetchMock = vi.fn(() => okJson(page([line("a", "第一条")])));
    vi.stubGlobal("fetch", fetchMock);
    const { loadComments, peekFilmComments } = await import("../src/film-comments");

    await loadComments();
    await loadComments();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await loadComments(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(peekFilmComments().items.map((i) => i.comment)).toEqual(["第一条"]);
    expect(peekFilmComments().loaded).toBe(true);
  });

  it("追加一页;失败时**留着游标**(还能再点一次),成功后才接到尾巴上", async () => {
    let secondPageOK = false;
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(String(url));
      if (String(url).includes("cursor=C1")) {
        return secondPageOK ? okJson(page([line("b", "第二条")])) : fail(500);
      }
      return okJson(page([line("a", "第一条")], "C1"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { loadComments, loadMoreComments, peekFilmComments } = await import(
      "../src/film-comments"
    );

    await loadComments();
    expect(peekFilmComments().items.map((i) => i.comment)).toEqual(["第一条"]);
    expect(peekFilmComments().nextCursor).toBe("C1");

    // 失败:列表一动不动,游标留着 —— 把它清掉等于告诉用户「后面没有了」
    await loadMoreComments();
    expect(peekFilmComments().items.map((i) => i.comment)).toEqual(["第一条"]);
    expect(peekFilmComments().nextCursor).toBe("C1");

    secondPageOK = true;
    await loadMoreComments();
    expect(peekFilmComments().items.map((i) => i.comment)).toEqual(["第一条", "第二条"]);
    expect(peekFilmComments().nextCursor).toBeNull();

    // 没有下一页了 → 不再发请求
    const settled = calls.length;
    await loadMoreComments();
    expect(calls.length).toBe(settled);
  });

  it("连点两次「加载更多」:同一时刻只有一页在飞(不重复追加)", async () => {
    const calls: string[] = [];
    let resolveSecond: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      calls.push(String(url));
      if (String(url).includes("cursor=C1")) {
        return new Promise((resolve) => {
          resolveSecond = () => resolve(okJson(page([line("b", "第二条")])));
        });
      }
      return okJson(page([line("a", "第一条")], "C1"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { loadComments, loadMoreComments, peekFilmComments } = await import(
      "../src/film-comments"
    );

    await loadComments();
    const both = Promise.all([loadMoreComments(), loadMoreComments()]);
    expect(calls.length).toBe(2); // 第一页 + 一次「加载更多」
    resolveSecond!(undefined);
    await both;
    expect(calls.length).toBe(2);
    expect(peekFilmComments().items.map((i) => i.comment)).toEqual(["第一条", "第二条"]);
  });

  it("降级(第一页就失败)也算「取过了」:进页面不会无限重试,空态照样出得来", async () => {
    const fetchMock = vi.fn(() => fail(503));
    vi.stubGlobal("fetch", fetchMock);
    const { loadComments, peekFilmComments } = await import("../src/film-comments");

    await loadComments();
    await loadComments();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekFilmComments()).toMatchObject({ items: [], nextCursor: null, loaded: true });
  });
});

describe("订阅:每次状态变化广播一次", () => {
  it("加载完成后通知订阅者(视图层据此重渲染)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => okJson(page([line("a", "好看")]))));
    const { loadComments, onFilmCommentsChange } = await import("../src/film-comments");

    let hits = 0;
    const off = onFilmCommentsChange(() => {
      hits += 1;
    });
    await loadComments();
    expect(hits).toBeGreaterThan(0);
    off();
    const before = hits;
    await loadComments();
    expect(hits).toBe(before);
  });
});
