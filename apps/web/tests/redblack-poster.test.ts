// 红黑榜分享图的**模型层**(2026-09-22)。
// 为什么单测它:出图是「对外的成品」,选错榜 / 少画一节 / 顺序与页面不一致,都只会表现为
// 「图里的数字对不上页面上看到的东西」—— 不报错、不崩,只能靠断言守。
// 绘制本身(像素)不做断言:E2E 用 `__paintedTexts` 断言「画出来的字」。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import {
  buildRbPosterModel,
  CREDIT_BY,
  rbPosterHeight,
  ROW_H,
  SITE,
  TOP_N,
  type RbPosterInput,
} from "../src/redblack-poster";
import type { CrowdCounts, StickerBoard } from "../src/redblack";
import { show } from "./helpers";

/** 最小有排期的 FilmNode(`boardFilms` 只要求 `shows.length > 0`) */
function film(key: string, zh = key, en = ""): FilmNode {
  return {
    key,
    title: zh,
    en,
    zh,
    names: [],
    meta: "",
    cats: [],
    shows: [show({ code: key })],
  };
}

function crowd(entries: Record<string, [number, number]>): CrowdCounts {
  return new Map(Object.entries(entries).map(([k, [red, black]]) => [k, { red, black, total: red + black }]));
}

function input(over: Partial<RbPosterInput> = {}): RbPosterInput {
  return {
    films: [],
    crowd: new Map(),
    board: new Map(),
    site: { total: 0, red: 0, black: 0 },
    mine: { marked: 0, placed: 0, quota: 0 },
    today: new Date(2026, 8, 22), // 2026-09-22
    ...over,
  };
}

const boardOf = (entries: Record<string, "red" | "black">): StickerBoard =>
  new Map(Object.entries(entries).map(([k, type]) => [k, [{ id: `s-${k}`, type, posX: 0.5, posY: 0.5 }]]));

describe("buildRbPosterModel:三个榜各 TOP10,判据与页面同口径", () => {
  it("总数榜按红 + 黑、红榜按红、黑榜按黑 —— 三榜各排各的", () => {
    const films = [film("a", "甲"), film("b", "乙"), film("c", "丙")];
    const c = crowd({ a: [9, 1], b: [1, 9], c: [5, 5] });
    const model = buildRbPosterModel(input({ films, crowd: c }));

    const byLabel = new Map(model.boards.map((b) => [b.label, b.rows.map((r) => r.key)]));
    // 总数:a=10 与 c=10 并列 → 按目录序稳定(a 在 c 前);b=10 也是 10!三者同分 → 全按目录序
    expect(byLabel.get("总数榜")).toEqual(["a", "b", "c"]);
    expect(byLabel.get("红榜")).toEqual(["a", "c", "b"]);
    expect(byLabel.get("黑榜")).toEqual(["b", "c", "a"]);
  });

  it("每榜最多 10 行,且带上口径说明", () => {
    const films = Array.from({ length: 14 }, (_, i) => film(`f${i}`));
    const c = crowd(Object.fromEntries(films.map((f, i) => [f.key, [14 - i, 0] as [number, number]])));
    const model = buildRbPosterModel(input({ films, crowd: c }));

    const total = model.boards.find((b) => b.mode === "total")!;
    expect(total.rows).toHaveLength(TOP_N);
    expect(total.label).toBe("总数榜");
    expect(total.hint).toBe("按红 + 黑贴纸数");
    expect(total.rows[0].key).toBe("f0");
    expect(model.boards.find((b) => b.mode === "red")!.hint).toBe("按红贴纸数");
  });

  it("没票的片不进榜(写着一部 0 红 0 黑的片没有意义)", () => {
    const films = [film("a"), film("silent"), film("b")];
    const model = buildRbPosterModel(input({ films, crowd: crowd({ a: [1, 0], b: [0, 1] }) }));
    const keys = model.boards.flatMap((b) => b.rows.map((r) => r.key));
    expect(keys).not.toContain("silent");
    expect(model.boards.find((b) => b.mode === "total")!.rows).toHaveLength(2);
  });

  it("一个榜都没有票 → 该榜整节不出现(不留空节)", () => {
    const films = [film("a"), film("b")];
    // 只有红票 → 黑榜是空的
    const model = buildRbPosterModel(input({ films, crowd: crowd({ a: [3, 0], b: [1, 0] }) }));
    expect(model.boards.map((b) => b.mode)).toEqual(["total", "red"]);
  });

  it("完全空榜 → 三节都不出现(绘制层会给一句空态)", () => {
    const model = buildRbPosterModel(input({ films: [film("a")] }));
    expect(model.boards).toEqual([]);
    expect(model.myRows).toEqual([]);
  });

  it("没有场次的片不进榜(与页面 boardFilms 同一道门槛)", () => {
    const noShows = { ...film("ghost"), shows: [] };
    const model = buildRbPosterModel(
      input({ films: [film("a"), noShows as FilmNode], crowd: crowd({ a: [1, 0], ghost: [99, 99] }) }),
    );
    expect(model.boards[0].rows.map((r) => r.key)).toEqual(["a"]);
    expect(model.site.films).toBe(1);
  });
});

describe("buildRbPosterModel:我贴过的那一节", () => {
  it("不限条数 —— 贴了多少列多少,而且不截断到 10", () => {
    const films = Array.from({ length: 15 }, (_, i) => film(`f${i}`));
    const c = crowd(Object.fromEntries(films.map((f, i) => [f.key, [15 - i, 0] as [number, number]])));
    const model = buildRbPosterModel(input({ films, crowd: c, board: boardOf(Object.fromEntries(films.map((f) => [f.key, "red" as const]))) }));
    expect(model.myRows).toHaveLength(15);
    expect(model.myTitle).toBe("我贴过的 15 部");
  });

  it("每行带「我贴的那一色」与「全站红黑数」", () => {
    const model = buildRbPosterModel(
      input({
        films: [film("a"), film("b")],
        crowd: crowd({ a: [12, 3], b: [0, 4] }),
        board: boardOf({ a: "red", b: "black" }),
      }),
    );
    expect(model.myRows.map((r) => [r.key, r.mine, r.red, r.black])).toEqual([
      ["a", "red", 12, 3],
      ["b", "black", 0, 4],
    ]);
  });

  it("按全站总数降序(= 页面默认档同口径),并列按目录序", () => {
    const films = [film("a"), film("b"), film("c")];
    const model = buildRbPosterModel(
      input({
        films,
        crowd: crowd({ a: [1, 1], b: [9, 0], c: [0, 5] }),
        board: boardOf({ a: "red", b: "red", c: "black" }),
      }),
    );
    expect(model.myRows.map((r) => r.key)).toEqual(["b", "c", "a"]);
  });

  it("中英名相同 → 不重复画一遍(与页面卡片同一条展示规则)", () => {
    const model = buildRbPosterModel(
      input({
        films: [film("a", "In Winter", "In Winter"), film("b", "中文名", "English Title")],
        crowd: crowd({ a: [1, 0], b: [1, 0] }),
      }),
    );
    const rows = model.boards[0].rows;
    // 排期里只有英文名的片,`zh` 会回落到英文名 —— 两行一模一样会显得是 bug
    expect(rows.find((r) => r.key === "a")!.en).toBe("");
    expect(rows.find((r) => r.key === "b")!.en).toBe("English Title");
  });

  it("没贴过任何一部 → 该节不出现", () => {
    const model = buildRbPosterModel(input({ films: [film("a")], crowd: crowd({ a: [3, 0] }) }));
    expect(model.myRows).toEqual([]);
    expect(model.myTitle).toBe("我贴过的 0 部");
  });
});

describe("buildRbPosterModel:头部与署名", () => {
  it("届次 / 日期 / 影片数进文案(日期是注入的,不读时钟)", () => {
    const model = buildRbPosterModel(input({ films: [film("a"), film("b")] }));
    expect(model.eyebrow).toBe("BIFF 2026 · 观影红黑榜");
    expect(model.title).toBe("红黑榜");
    expect(model.subtitle).toBe("2026-09-22 · 2 部有排期的影片");
    expect(model.site.films).toBe(2);
  });

  it("全站与我那两份数字**照传进来的用**(与页面 hero 同一份,不重算)", () => {
    const model = buildRbPosterModel(
      input({ site: { total: 20629, red: 11919, black: 8710 }, mine: { marked: 72, placed: 60, quota: 12 } }),
    );
    expect(model.site).toMatchObject({ total: 20629, red: 11919, black: 8710 });
    expect(model.mine).toEqual({ marked: 72, placed: 60, quota: 12 });
  });

  it("底部署名 = 网站 + 作者(与页面页脚逐字一致)", () => {
    const model = buildRbPosterModel(input());
    expect(model.credit.site).toBe(SITE);
    expect(model.credit.by).toBe(CREDIT_BY);
    // ⚠ 用 GitHub **账号名**(`@lcandy2`),不是提交者显示名 `@citron` —— 图片上没有链接,
    //   印显示名没人搜得到(2026-09-22 用户:「新版需要对齐旧版页脚」)
    expect(model.credit.by).toBe("by @gaaiyeoi 和 by @lcandy2");
  });
});

describe("rbPosterRow:每行摊出来的贴纸", () => {
  it("几枚就画几枚,颜色构成与数字一致", () => {
    const model = buildRbPosterModel(
      input({ films: [film("a")], crowd: crowd({ a: [3, 2] }) }),
    );
    const row = model.boards[0].rows[0];
    expect(row.stickers).toHaveLength(5);
    expect(row.stickers.filter((s) => s.type === "red")).toHaveLength(3);
    expect(row.stickers.filter((s) => s.type === "black")).toHaveLength(2);
  });

  it("落点与歪斜是**确定性**的:同一份数据两次构建结果逐字相同", () => {
    const build = () =>
      buildRbPosterModel(input({ films: [film("a")], crowd: crowd({ a: [4, 1] }) }));
    expect(build().boards[0].rows[0].stickers).toEqual(build().boards[0].rows[0].stickers);
    // 相对坐标落在 0–1 之间(与卡片画布同一口径)
    for (const s of build().boards[0].rows[0].stickers) {
      expect(s.posX).toBeGreaterThan(0);
      expect(s.posX).toBeLessThan(1);
      expect(s.posY).toBeGreaterThan(0);
      expect(s.posY).toBeLessThan(1);
      expect(Math.abs(s.tilt)).toBeLessThanOrEqual(15);
    }
  });

  it("我贴过的那一部:群点只算「别人的」,我那一枚**追加在末尾**并记下标(绘制时加亮边)", () => {
    const model = buildRbPosterModel(
      input({
        films: [film("a")],
        crowd: crowd({ a: [3, 2] }),
        board: boardOf({ a: "red" }),
      }),
    );
    const row = model.boards[0].rows[0];
    // 全体 5 枚不变(服务端那份含我),但组成是「别人的 4 + 我 1」
    expect(row.stickers).toHaveLength(5);
    expect(row.mineIndex).toBe(4);
    expect(row.stickers[row.mineIndex].type).toBe("red");
    // 卡片画布的群点是「别人的」——这里也必须是同一批:去掉我那一枚后,红只剩 2
    expect(row.stickers.slice(0, 4).filter((s) => s.type === "red")).toHaveLength(2);
    expect(row.stickers.slice(0, 4).filter((s) => s.type === "black")).toHaveLength(2);
  });

  it("没贴过的片:没有「我那一枚」,`mineIndex` = -1", () => {
    const model = buildRbPosterModel(input({ films: [film("a")], crowd: crowd({ a: [1, 1] }) }));
    const row = model.boards[0].rows[0];
    expect(row.stickers).toHaveLength(2);
    expect(row.mineIndex).toBe(-1);
  });

  it("服务端票数还没含我时不会画出负数(≥ 0)", () => {
    // 服务端 0 票 + 我贴了 1 枚 → 别人的 0(夹到 0),我那一枚照画
    const model = buildRbPosterModel(
      input({ films: [film("a")], board: boardOf({ a: "black" }) }),
    );
    const row = model.myRows[0];
    expect(row.stickers).toHaveLength(1);
    expect(row.stickers[0].type).toBe("black");
    expect(row.mineIndex).toBe(0);
    expect(row.red).toBe(0);
    expect(row.black).toBe(0);
  });
});

describe("rbPosterHeight:与绘制同源", () => {
  const ONE_ROW = ROW_H;

  it("「我贴过的」多一行 → 高度正好多一行(且两边的三榜完全一样)", () => {
    // base:b 没有票 → 三榜只由 a 组成;但 b 我贴过 → 只在「我贴过的」多一行
    const base = buildRbPosterModel(
      input({ films: [film("a"), film("b")], crowd: crowd({ a: [1, 0] }), board: boardOf({ a: "red" }) }),
    );
    const plus = buildRbPosterModel(
      input({
        films: [film("a"), film("b")],
        crowd: crowd({ a: [1, 0] }),
        board: boardOf({ a: "red", b: "black" }),
      }),
    );
    expect(plus.boards).toEqual(base.boards); // 三榜一字未变,只有我的那一节多一行
    expect(rbPosterHeight(plus) - rbPosterHeight(base)).toBe(ONE_ROW);
  });

  it("空榜不留高度:没有三榜节 / 没有我的那一节时更矮", () => {
    const empty = buildRbPosterModel(input({ films: [film("a")] }));
    const withBoard = buildRbPosterModel(
      input({ films: [film("a")], crowd: crowd({ a: [1, 0] }), board: boardOf({ a: "red" }) }),
    );
    expect(rbPosterHeight(empty)).toBeLessThan(rbPosterHeight(withBoard));
    // 空榜只剩头部与页脚,但仍然是一张完整的图(不是 0 高)
    expect(rbPosterHeight(empty)).toBeGreaterThan(0);
  });
});
