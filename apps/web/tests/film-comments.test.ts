// 红黑榜「讨论区」评语客户端（2026-09-29）。
//
// 为什么单测它：下面这几条判据错了**都不会报错**，只会「看起来少了几行」——
//   ① 白名单太松 → 半截响应里的坏行渲染成空白的一行；
//   ② 按片过滤没带上 → 弹层里列出**别的片**的评语（最像「功能正常」的那种错）；
//   ③ 合并一页的规则错 → 「加载更多」把同一页追加两遍，或一次失败之后再也翻不动；
//   ④ 失败没有降级 → 接口没上线时整个弹层崩，而评语只是附加内容。
//
// ⚠ 模块本身**不再持有状态**（那是弹层实例的事，见上一轮改造），所以这里只测纯函数与一次请求；
//   「列表 + 游标」的状态机在 `mergeCommentPage` 里，单独一组用例钉住它。

import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_COMMENT_LIST, mergeCommentPage } from "../src/film-comments";

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

  // 讨论区问的是「**这一部**的评语」。不带过滤的话服务端回的是全场评语 ——
  // 而弹层照样能渲染，只是列出来的是别的片，**看起来完全正常**。
  it("★ 按片读：带上 `filmKey`（不带就是全场，两个入口会同一条数据错位）", async () => {
    const fetchMock = vi.fn((_url: string) => okJson(page([])));
    vi.stubGlobal("fetch", fetchMock);
    const { loadFilmComments } = await import("../src/film-comments");

    await loadFilmComments({ filmKey: "cat:f008", cursor: null });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("filmKey=cat%3Af008");

    // 没给片子时**不能**凭空多一个空参数（空串会被服务端当成「非法 → 不过滤」）
    await loadFilmComments();
    const bare = String(fetchMock.mock.calls[1]![0]);
    expect(bare).not.toContain("filmKey=");
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

// 「列表 + 游标」的状态机（原来住在模块级单例里，现在住在弹层实例里 —— 但规则一字未改）。
describe("mergeCommentPage：一页怎么并进列表", () => {
  const loaded = (comment: string, nextCursor: string | null = null) =>
    mergeCommentPage(
      EMPTY_COMMENT_LIST,
      { items: [line("a", comment)], nextCursor },
      null,
    );

  it("第一页**换掉**整份列表（不是接在旧的后面）", () => {
    const first = loaded("第一条", "C1");
    expect(first.items.map((i) => i.comment)).toEqual(["第一条"]);
    expect(first.nextCursor).toBe("C1");
    expect(first.loaded).toBe(true);
    expect(first.loading).toBe(false);

    // 再取一次第一页（写了评语之后重拉）→ 列表被替换，不会出现重复的第一条
    const again = mergeCommentPage(first, { items: [line("a", "改过的")], nextCursor: null }, null);
    expect(again.items.map((i) => i.comment)).toEqual(["改过的"]);
    expect(again.nextCursor).toBeNull();
  });

  it("★ 加载更多：接到尾巴上，并推进游标", () => {
    const first = loaded("第一条", "C1");
    const second = mergeCommentPage(first, { items: [line("b", "第二条")], nextCursor: "C2" }, "C1");
    expect(second.items.map((i) => i.comment)).toEqual(["第一条", "第二条"]);
    expect(second.nextCursor).toBe("C2");
  });

  it("★ 追加拿到空页 → **游标留着**（那多半是这次失败了，再点一次还能重试）", () => {
    const first = loaded("第一条", "C1");
    const afterFail = mergeCommentPage(first, { items: [], nextCursor: null }, "C1");
    expect(afterFail.items.map((i) => i.comment)).toEqual(["第一条"]);
    // 把它清掉等于告诉用户「后面没有了」—— 而那是假的
    expect(afterFail.nextCursor).toBe("C1");
  });

  it("★ 降级（第一页就失败）也算「取过了」：进弹层不会无限重试，空态照样出得来", () => {
    const degraded = mergeCommentPage(EMPTY_COMMENT_LIST, { items: [], nextCursor: null }, null);
    expect(degraded).toMatchObject({ items: [], nextCursor: null, loaded: true, loading: false });
  });

  it("loading 与 items 一起换：合并的那一刻一定不再在加载中", () => {
    const loading = { ...EMPTY_COMMENT_LIST, loading: true };
    expect(mergeCommentPage(loading, { items: [], nextCursor: null }, null).loading).toBe(false);
  });
});
