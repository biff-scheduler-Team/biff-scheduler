// 红黑榜分享图的**模型层**(2026-09-22)。
// 为什么单测它:出图是「对外的成品」,选错榜 / 少画一节 / 顺序与页面不一致,都只会表现为
// 「图里的数字对不上页面上看到的东西」—— 不报错、不崩,只能靠断言守。
// 绘制本身(像素)不做断言:E2E 用 `__paintedTexts` 断言「画出来的字」。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import {
  buildRankPosterModel,
  buildRbPosterModel,
  CREDIT_BY,
  posterUnitOptions,
  rbPosterHeight,
  ROW_H,
  SITE,
  TOP_N,
  type RbPosterInput,
  type RbPosterSection,
  type RbRankPosterInput,
} from "../src/redblack-poster";
import type { CrowdCounts, StickerBoard } from "../src/redblack";
import type { FilmItem } from "../src/types";
import { show } from "./helpers";

/** 最小有排期的 FilmNode(`boardFilms` 只要求 `shows.length > 0`) */
function film(key: string, zh = key, en = "", poster?: string): FilmNode {
  return {
    key,
    title: zh,
    en,
    zh,
    names: [],
    meta: "",
    cats: [],
    shows: [show({ code: key })],
    poster,
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
    mine: { placed: 0 },
    ...over,
  };
}

const boardOf = (entries: Record<string, "red" | "black">): StickerBoard =>
  new Map(Object.entries(entries).map(([k, type]) => [k, [{ id: `s-${k}`, type, posX: 0.5, posY: 0.5 }]]));

describe("buildRbPosterModel:两个榜各 TOP10,判据与页面同口径", () => {
  it("红榜按红票降序、黑榜按黑票降序 —— 两榜各看自己那一色(2026-10-14 改按数量)", () => {
    const films = [film("a", "甲"), film("b", "乙"), film("c", "丙")];
    const c = crowd({ a: [9, 1], b: [1, 9], c: [5, 5] });
    const model = buildRbPosterModel(input({ films, crowd: c }));

    const byLabel = new Map(model.boards.map((b) => [b.label, b.rows.map((r) => r.key)]));
    // 红票 a = 9、c = 5、b = 1；黑票 b = 9、c = 5、a = 1
    expect(byLabel.get("红榜")).toEqual(["a", "c", "b"]);
    expect(byLabel.get("黑榜")).toEqual(["b", "c", "a"]);
  });

  it("每榜最多 10 行,且带上口径说明", () => {
    const films = Array.from({ length: 14 }, (_, i) => film(`f${i}`));
    const c = crowd(Object.fromEntries(films.map((f, i) => [f.key, [14 - i, 0] as [number, number]])));
    const model = buildRbPosterModel(input({ films, crowd: c }));

    // 全是红票 → 黑榜那一色一票都没有，整节不出现
    expect(model.boards.map((b) => b.mode)).toEqual(["red"]);
    const red = model.boards[0];
    expect(red.rows).toHaveLength(TOP_N);
    expect(red.label).toBe("红榜");
    expect(red.hint).toBe("按红贴纸数（多在前）· 同数量比评分");
    // 全站全是红票 → 每部评分都是 10.0，名次由**票数**定：f0 票最多，排第一
    expect(red.rows[0].key).toBe("f0");
    expect(red.rows[0].score).toBe(10);
  });

  it("每行带**评分**（与页面卡片角标同一处实现）", () => {
    const films = [film("a"), film("b")];
    const model = buildRbPosterModel(input({ films, crowd: crowd({ a: [9, 1], b: [0, 4] }), priorRate: 0.5 }));
    const scores = new Map(model.boards.flatMap((b) => b.rows.map((r) => [r.key, r.score])));
    // a = (9 + 2.5)/15 = 7.7；b = (0 + 2.5)/9 = 2.8
    expect(scores.get("a")).toBe(7.7);
    expect(scores.get("b")).toBe(2.8);
  });

  it("priorRate 传进来就用它（页面那份），不传才按 crowd 现算", () => {
    const films = [film("a")];
    const c = crowd({ a: [1, 1] });
    // C = 1 → (1 + 5)/7 = 8.6；按 crowd 现算 C = 0.5 → (1 + 2.5)/7 = 5.0
    expect(buildRbPosterModel(input({ films, crowd: c, priorRate: 1 })).boards[0].rows[0].score).toBe(8.6);
    expect(buildRbPosterModel(input({ films, crowd: c })).boards[0].rows[0].score).toBe(5);
  });

  it("没票的片不进榜(写着一部 0 红 0 黑的片没有意义)", () => {
    const films = [film("a"), film("silent"), film("b")];
    const model = buildRbPosterModel(input({ films, crowd: crowd({ a: [1, 0], b: [0, 1] }) }));
    const keys = model.boards.flatMap((b) => b.rows.map((r) => r.key));
    expect(keys).not.toContain("silent");
    expect(model.boards.find((b) => b.mode === "red")!.rows).toHaveLength(1);
  });

  it("某一榜那一色一票都没有 → 该榜整节不出现(不留空节)", () => {
    const films = [film("a"), film("b")];
    // 只有红票 → 黑榜是空的
    const model = buildRbPosterModel(input({ films, crowd: crowd({ a: [3, 0], b: [1, 0] }) }));
    expect(model.boards.map((b) => b.mode)).toEqual(["red"]);
  });

  it("完全空榜 → 两节都不出现(绘制层会给一句空态)", () => {
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

  it("按全站总数降序(它是清单不是榜,不跟榜单改成评分口径),并列按目录序", () => {
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
    // ⚠ 2026-10-21 口径变更（`PLAN-20261021194253`，用户「去掉 OCT 21 · 315 部有排期的影片这个」）：
    //   副标题不再拼日期与片数 —— 不选单元时就是空串（绘制层对这一档整行不画）。
    //   这是**有意改行为**，不是为让测试变绿而改实现。
    expect(model.subtitle).toBe("");
    expect(model.site.films).toBe(2);
  });

  it("全站与我那两份数字**照传进来的用**(与页面 hero 同一份,不重算)", () => {
    const model = buildRbPosterModel(
      input({ site: { total: 20629, red: 11919, black: 8710 }, mine: { placed: 60 } }),
    );
    expect(model.site).toMatchObject({ total: 20629, red: 11919, black: 8710 });
    expect(model.mine).toEqual({ placed: 60 });
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

describe("buildRbPosterModel:分享哪些节由用户勾选", () => {
  const films = [film("a", "甲"), film("b", "乙"), film("c", "丙")];
  const c = crowd({ a: [9, 1], b: [1, 9], c: [5, 5] });
  const board = boardOf({ a: "red", b: "black" });
  const sections = (...ids: RbPosterSection[]) => new Set<RbPosterSection>(ids);

  it("只勾红榜 → 图里只有红榜这一节", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, board, sections: sections("red") }));
    expect(model.boards.map((b) => b.mode)).toEqual(["red"]);
    expect(model.myRows).toEqual([]);
    // 渲染顺序**按固定档位序**,不随勾选顺序变
    const both = buildRbPosterModel(input({ films, crowd: c, board, sections: sections("black", "red") }));
    expect(both.boards.map((b) => b.mode)).toEqual(["red", "black"]);
  });

  it("不勾「我贴过的」→ 那一节不出现,但标题里的条数照旧(不变成 0 部)", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, board, sections: sections("red") }));
    expect(model.myRows).toEqual([]);
    expect(model.myCount).toBe(2);
    expect(model.myTitle).toBe("我贴过的 2 部");
  });

  it("一节都不勾 → 只剩头部与署名,而且空态文案说的是「还没选」不是「榜上没贴纸」", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, board, sections: sections() }));
    expect(model.boards).toEqual([]);
    expect(model.myRows).toEqual([]);
    expect(model.emptyText).toContain("还没选");
    // 有票却一节都没勾时,更不能说成「榜上还没有贴纸」
    expect(model.emptyText).not.toContain("还没有贴纸");
  });

  it("不传 sections = 全选(默认给全,「少给」才需要动作)", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, board }));
    expect(model.boards.map((b) => b.mode)).toEqual(["red", "black"]);
    expect(model.myRows).toHaveLength(2);
  });

  it("真的一枚票都没有时,空态文案才是「榜上还没有贴纸」", () => {
    const model = buildRbPosterModel(input({ films }));
    expect(model.emptyText).toContain("还没有贴纸");
  });
});

describe("rbPosterHeight:与绘制同源", () => {
  const ONE_ROW = ROW_H;

  it("「我贴过的」多一行 → 高度正好多一行(且两边的榜单完全一样)", () => {
    // base:b 没有票 → 两榜只由 a 组成;但 b 我贴过 → 只在「我贴过的」多一行
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
    expect(plus.boards).toEqual(base.boards); // 两榜一字未变,只有我的那一节多一行
    expect(rbPosterHeight(plus) - rbPosterHeight(base)).toBe(ONE_ROW);
  });

  it("空榜不留高度:没有榜单节 / 没有我的那一节时更矮", () => {
    const empty = buildRbPosterModel(input({ films: [film("a")] }));
    const withBoard = buildRbPosterModel(
      input({ films: [film("a")], crowd: crowd({ a: [1, 0] }), board: boardOf({ a: "red" }) }),
    );
    expect(rbPosterHeight(empty)).toBeLessThan(rbPosterHeight(withBoard));
    // 空榜只剩头部与页脚,但仍然是一张完整的图(不是 0 高)
    expect(rbPosterHeight(empty)).toBeGreaterThan(0);
  });
});

describe("rbPosterRow:行内海报缩略图(2026-10-08)", () => {
  it("目录里有海报就带出来 —— 榜单与「我贴过的」是同一份来源,不另立一套", () => {
    const model = buildRbPosterModel(
      input({
        films: [film("a", "甲", "", "/posters/a.jpg"), film("b", "乙")],
        crowd: crowd({ a: [3, 0], b: [2, 0] }),
        board: boardOf({ a: "red" }),
      }),
    );
    const rowA = model.boards[0].rows.find((r) => r.key === "a")!;
    const rowB = model.boards[0].rows.find((r) => r.key === "b")!;
    expect(rowA.poster).toBe("/posters/a.jpg");
    // 缺图是常态(250 部里 174 部有):没有就**不编一个**路径出来,绘制层据此走占位块
    expect(rowB.poster).toBeUndefined();
    expect(model.myRows.find((r) => r.key === "a")!.poster).toBe("/posters/a.jpg");
  });

  it("海报**不改变行高**:有没有图高度一模一样(缺图走占位块,而不是不留位)", () => {
    const withArt = buildRbPosterModel(
      input({ films: [film("a", "甲", "", "/posters/a.jpg")], crowd: crowd({ a: [1, 0] }) }),
    );
    const without = buildRbPosterModel(
      input({ films: [film("a", "甲")], crowd: crowd({ a: [1, 0] }) }),
    );
    // ⚠ 行高是绘制与 `rbPosterHeight` 的共用自变量:带图改高度就会两处错位、静默裁图
    expect(rbPosterHeight(withArt)).toBe(rbPosterHeight(without));
  });
});

/* ---------------- 2026-10-14 新增:单元 / 条数 / 头尾（PLAN-20261014150805 修订 2） ----------------
 *
 * 这一组守的是「分享的时候可以选择需要哪个单元的就行」那件事：**范围**选错不会崩、不会报错，
 * 只会安静地发出一张内容不对的图 —— 只有断言拦得住。
 */

describe("buildRbPosterModel:按单元切分", () => {
  /** 带单元的影片（单元挂在目录条目上；`also` = 联映块单元的成员关系）。 */
  function inUnit(key: string, unit: string, zh = key, also?: string[]): FilmNode {
    return { ...film(key, zh), cats: [{ unit, also_units: also } as FilmItem] };
  }

  const films = [
    inUnit("a", "甲单元"),
    inUnit("b", "乙单元"),
    inUnit("c", "甲单元"),
  ];
  const c = crowd({ a: [1, 0], b: [0, 1], c: [1, 0] });

  it("只列该单元：另一单元的片连同它的票一起被切掉", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, unit: "甲单元" }));
    const keys = model.boards.flatMap((b) => b.rows.map((r) => r.key));
    expect(keys).toEqual(["a", "c"]);
    // 全站影片数也跟着切 —— 图上那句「N 部有排期的影片」说的必须是**这个单元**的规模
    expect(model.site.films).toBe(2);
    expect(model.unitName).toBe("甲单元");
  });

  it("单元名进副标题（只印 5 行红榜却不说哪一单元，读图的人判断不了自己在看什么）", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, unit: "甲单元" }));
    expect(model.subtitle).toBe("甲单元");
    // 不选单元时副标题是空串（2026-10-21 去掉日期与片数，见 `PLAN-20261021194253`）
    expect(buildRbPosterModel(input({ films, crowd: c })).subtitle).toBe("");
  });

  it("「我贴过的」也一起切（这张图只讲这个单元），`myCount` 是切后的数", () => {
    const model = buildRbPosterModel(
      input({
        films,
        crowd: c,
        unit: "甲单元",
        board: boardOf({ a: "red", b: "black" }),
      }),
    );
    expect(model.myRows.map((r) => r.key)).toEqual(["a"]);
    // ⚠ 弹层里那句「我贴过的（N 部）」读的就是 `myCount`，它必须已经切过
    expect(model.myCount).toBe(1);
  });

  it("这个单元一票没有 → 空态说的是「这个单元」，不是「榜上还没有贴纸」", () => {
    const model = buildRbPosterModel(input({ films, crowd: crowd({ b: [1, 0] }), unit: "甲单元" }));
    expect(model.boards).toEqual([]);
    expect(model.emptyText).toContain("甲单元");
    // 与「真的没票」那句区分开：后者把用户支去贴票，而这里贴票也不解决他的问题（他要的是另一个单元）
    expect(model.emptyText).not.toContain("去「看过」");
  });
});

describe("buildRbPosterModel:每榜条数 topN", () => {
  const films = Array.from({ length: 14 }, (_, i) => film(`f${i}`));
  const c = crowd(Object.fromEntries(films.map((f, i) => [f.key, [14 - i, 0] as [number, number]])));

  it("topN = 5 → 每榜只留 5 行（不是 10）", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, topN: 5 }));
    expect(model.boards[0].rows).toHaveLength(5);
    expect(model.boards[0].rows.map((r) => r.key)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
  });

  it("榜里不够 topN 时**全列**，不补零", () => {
    const model = buildRbPosterModel(
      input({ films: films.slice(0, 2), crowd: crowd({ f0: [2, 0], f1: [1, 0] }), topN: 10 }),
    );
    expect(model.boards[0].rows).toHaveLength(2);
  });

  it("topN <= 0 = 不截断（弹层那一档叫「全部」）", () => {
    const model = buildRbPosterModel(input({ films, crowd: c, topN: 0 }));
    expect(model.boards[0].rows).toHaveLength(14);
  });

  it("不传 topN 仍是 10（默认值没被这次的参数化改掉）", () => {
    const model = buildRbPosterModel(input({ films, crowd: c }));
    expect(model.boards[0].rows).toHaveLength(TOP_N);
  });

  it("topNByBoard：红榜 5 行、黑榜 12 行 —— 两榜各按自己那一档取", () => {
    // 2026-10-21（用户「红黑榜单独设置需要的名次」）：黑榜有票的片本来就少，
    // 红榜想只放前 5、黑榜想放全部是常态，两档互不牵连。
    const all = Array.from({ length: 14 }, (_, i) => film(`f${i}`));
    const both = crowd(
      Object.fromEntries(all.map((f, i) => [f.key, [14 - i, 14 - i] as [number, number]])),
    );
    const model = buildRbPosterModel(input({ films: all, crowd: both, topNByBoard: { red: 5, black: 12 } }));
    const red = model.boards.find((b) => b.mode === "red");
    const black = model.boards.find((b) => b.mode === "black");
    expect(red?.rows).toHaveLength(5);
    expect(black?.rows).toHaveLength(12);
  });

  it("topNByBoard 只给一榜时，另一榜回落到 topN（不是被悄悄截成 0）", () => {
    // ⚠ 两榜都要有票：`boardHasVotes` 会把「票数为 0」的那一榜整节去掉，缺数据时这条断言测不到回落
    const both = crowd(
      Object.fromEntries(films.map((f, i) => [f.key, [14 - i, 14 - i] as [number, number]])),
    );
    const model = buildRbPosterModel(input({ films, crowd: both, topN: 3, topNByBoard: { black: 7 } }));
    expect(model.boards.find((b) => b.mode === "red")?.rows).toHaveLength(3);
    expect(model.boards.find((b) => b.mode === "black")?.rows).toHaveLength(7);
  });
});

describe("rbPosterHeight:头尾开关只改高度，不改内容", () => {
  const films = [film("a"), film("b")];
  const c = crowd({ a: [2, 1], b: [1, 0] });

  it("关掉头部 → 高度少掉一个**与行数无关**的固定量", () => {
    const oneRow = [film("a")];
    const twoRows = films;
    // 行数不同、行高相同：差值（= 头部那一块）必须一致 —— 否则就是「少了一行的同时
    // 还多留了一块空白」，而那正是用户说的「不适合手机阅读」的来源
    const d1 =
      rbPosterHeight(buildRbPosterModel(input({ films: oneRow, crowd: c }))) -
      rbPosterHeight(buildRbPosterModel(input({ films: oneRow, crowd: c, showHeader: false })));
    const d2 =
      rbPosterHeight(buildRbPosterModel(input({ films: twoRows, crowd: c }))) -
      rbPosterHeight(buildRbPosterModel(input({ films: twoRows, crowd: c, showHeader: false })));
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBe(d1);
  });

  it("关掉署名 → 同样只少一个固定量；两个都关仍然是一张完整的图（> 0）", () => {
    const base = buildRbPosterModel(input({ films, crowd: c }));
    const noFooter = buildRbPosterModel(input({ films, crowd: c, showFooter: false }));
    const bare = buildRbPosterModel(input({ films, crowd: c, showHeader: false, showFooter: false }));
    expect(rbPosterHeight(base)).toBeGreaterThan(rbPosterHeight(noFooter));
    expect(rbPosterHeight(bare)).toBeLessThan(rbPosterHeight(noFooter));
    expect(rbPosterHeight(bare)).toBeGreaterThan(0);
  });

  it("头尾开关**不动**图里的内容（榜单 / 我贴过的 / 数字一字不变）", () => {
    const base = buildRbPosterModel(input({ films, crowd: c, board: boardOf({ a: "red" }) }));
    const bare = buildRbPosterModel(
      input({ films, crowd: c, board: boardOf({ a: "red" }), showHeader: false, showFooter: false }),
    );
    expect(bare.boards).toEqual(base.boards);
    expect(bare.myRows).toEqual(base.myRows);
    expect(bare.showHeader).toBe(false);
    expect(base.showHeader).toBe(true);
    expect(base.showFooter).toBe(true);
  });
});

describe("posterUnitOptions:弹层那个「单元」下拉的选项", () => {
  it("按单元去重、数出各单元片数，且**不含**未标单元的片", () => {
    const films: FilmNode[] = [
      { ...film("a"), cats: [{ unit: "乙单元" } as FilmItem] },
      { ...film("b"), cats: [{ unit: "甲单元" } as FilmItem] },
      { ...film("c"), cats: [{ unit: "甲单元" } as FilmItem] },
      film("d"), // 没有目录条目 → 没有单元
    ];
    const options = posterUnitOptions(films);
    expect(options).toHaveLength(2);
    // ⚠ 不在这里断言**顺序**:那一列按 `localeCompare` 的中文序排,而它随运行环境的
    //   ICU 数据变 —— 拿它当断言会变成「测环境」而不是「测口径」（与 `hot-board.test.ts` 同一条纪律）
    const byName = new Map(options.map((o) => [o.name, o.films]));
    expect(byName.get("甲单元")).toBe(2);
    expect(byName.get("乙单元")).toBe(1);
  });

  it("选项里的 id 与 `buildRbPosterModel` 的筛选用的是同一个键（否则会切出一张空图）", () => {
    const films: FilmNode[] = [{ ...film("a"), cats: [{ unit: "甲单元" } as FilmItem] }];
    const id = posterUnitOptions(films)[0].id;
    const model = buildRbPosterModel(
      input({ films, crowd: crowd({ a: [1, 0] }), unit: id }),
    );
    expect(model.boards[0].rows.map((r) => r.key)).toEqual(["a"]);
  });

  it("★ 回归：同一单元的多种写法合成**一项**（原先是 4 个同名选项，各 1 部片）", () => {
    // 2026-10-14 打开弹层实测：下拉里 4 行一模一样的
    // 「Asian Filmmaker of the Year · 年度亚洲电影人奖 · 杨紫琼专题，1 部」
    const films: FilmNode[] = [
      { ...film("a"), cats: [{ unit: "亚洲电影人奖" } as FilmItem] },
      { ...film("b"), cats: [{ unit: "年度亚洲电影人奖-杨紫琼专题" } as FilmItem] },
      { ...film("c"), cats: [{ unit: "2026年度亚洲电影人奖-杨紫琼专题" } as FilmItem] },
    ];
    const options = posterUnitOptions(films);
    expect(options).toHaveLength(1);
    expect(options[0].films).toBe(3);
    // 这个键也真的能切出全部 3 部 —— 「计数与筛选同源」的那条老规矩
    const model = buildRbPosterModel(
      input({ films, crowd: crowd({ a: [1, 0], b: [1, 0], c: [1, 0] }), unit: options[0].id }),
    );
    expect(model.boards[0].rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("联映块成员片在该单元的图上也会出现（与影片库的计数同源，不再少画那 4 部）", () => {
    const films: FilmNode[] = [
      {
        ...film("sapiens"),
        cats: [{ unit: "广角镜 - 纪录片放映", also_units: ["Midnight Passion"] } as FilmItem],
      },
      { ...film("in-unit"), cats: [{ unit: "Midnight Passion" } as FilmItem] },
    ];
    const options = posterUnitOptions(films);
    const midnight = options.find((o) => o.id === "Midnight Passion")!;
    expect(midnight.films).toBe(2);
    const model = buildRbPosterModel(
      input({ films, crowd: crowd({ sapiens: [1, 0], "in-unit": [1, 0] }), unit: midnight.id }),
    );
    expect(model.boards[0].rows.map((r) => r.key).sort()).toEqual(["in-unit", "sapiens"]);
  });
});

/* ---- 榜图档（`mode: "rank"`，2026-10-16 `PLAN-20261016000441` 修订 1）----
 * 用户原话：「排行榜生成的图片为什么是和红黑榜一样带评分的图片 而不是排行榜的图片?」
 *          「排行榜生成什么样的图就分享出来的也是什么样的图」。
 * ⚠ 这里断言的是**模型**；「图上真的没印评分」由 E2E 的 `paintedTexts` 断言
 *   （绘制是像素，模型层看不见 —— 与文件头那条分工一致）。 */
describe("buildRankPosterModel:榜图与屏上那一列同版式", () => {
  const films = [film("a"), film("b")];
  const c = crowd({ a: [9, 1], b: [0, 4] });
  const rank = (over: Partial<RbRankPosterInput> = {}) =>
    buildRankPosterModel({ films, crowd: c, priorRate: 0.5, ...over });

  it("档位是 rank 且头尾一律不画（「排行榜什么样，分享出来就什么样」）", () => {
    const model = rank();
    expect(model.mode).toBe("rank");
    expect(model.showHeader).toBe(false);
    expect(model.showFooter).toBe(false);
    // 头部那三行文案在图里没有落点 —— 留空，而不是编一个看着像真的
    expect([model.eyebrow, model.title, model.subtitle]).toEqual(["", "", ""]);
  });

  it("没有「我贴过的」那一节 —— 榜图只有榜（屏上也没有）", () => {
    const model = rank();
    expect(model.myRows).toEqual([]);
    expect(model.myCount).toBe(0);
  });

  it("行里**没有贴纸**、也没有「我贴的那一色」—— 这一档不含，不是省掉不画", () => {
    const row = rank().boards[0].rows[0];
    expect(row.stickers).toEqual([]);
    expect(row.mine).toBeNull();
    expect(row.mineIndex).toBe(-1);
  });

  it("评分**仍然算出来**（榜单按它排），只是不印 —— 不填 null", () => {
    // 与分享图那一档**逐字同一个数**（`redblack.ts::scoreOf`，先验 0.5）：两条口径共用一支
    expect(rank().boards[0].rows[0].score).toBe(7.7);
    expect(buildRbPosterModel(input({ films, crowd: c, priorRate: 0.5 })).boards[0].rows[0].score).toBe(7.7);
  });

  it("门槛与排序与屏上那一列同源：两榜各看自己那一色", () => {
    const model = rank();
    expect(model.boards.map((b) => b.mode)).toEqual(["red", "black"]);
    expect(model.boards[0].rows.map((r) => r.key)).toEqual(["a"]);
    // ⚠ 黑榜里 `a` 也在（它有 1 张黑贴纸）—— 门槛是「**该榜那一色**至少一票」，不是「只有它一色」
    expect(model.boards[1].rows.map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("能只画一榜（调用方按榜各出一张图）", () => {
    const model = rank({ sections: new Set<RbPosterSection>(["black"]) });
    expect(model.boards.map((b) => b.mode)).toEqual(["black"]);
  });

  it("topN 由调用方给：排行榜要的是 TOP50，不是分享图那个 TOP10 缺省档", () => {
    const many = Array.from({ length: 12 }, (_, i) => film(`f${i}`));
    const counts = crowd(
      Object.fromEntries(many.map((f, i) => [f.key, [20 - i, 0] as [number, number]])),
    );
    expect(buildRankPosterModel({ films: many, crowd: counts, topN: 50 }).boards[0].rows).toHaveLength(12);
    expect(buildRankPosterModel({ films: many, crowd: counts }).boards[0].rows).toHaveLength(TOP_N);
  });

  it("★ 双栏排版:高度按**栏带数**涨,不按行数（2 行仍占 1 带,3 行才多一带）", () => {
    // 2026-10-16 用户「空白的地方太多…重新排版充满图片」:单栏 50 行右半张全空,
    // 改成每榜左右两栏竖排 —— 高度只随 ceil(行数/2) 涨。
    const mk = (n: number) => {
      const films = Array.from({ length: n }, (_, i) => film(`f${i}`));
      const counts = crowd(
        Object.fromEntries(films.map((f, i) => [f.key, [20 - i, 0] as [number, number]])),
      );
      return buildRankPosterModel({
        films,
        crowd: counts,
        sections: new Set<RbPosterSection>(["red"]),
      });
    };
    expect(rbPosterHeight(mk(2))).toBe(rbPosterHeight(mk(1)));
    expect(rbPosterHeight(mk(3))).toBe(rbPosterHeight(mk(1)) + ROW_H);
    // 双栏把宽度用满:同样 6 行,高度比「行数 × ROW_H」的单栏少一截
    expect(rbPosterHeight(mk(6))).toBe(rbPosterHeight(mk(1)) + 2 * ROW_H);
  });

  it("头尾不画 ⇒ 比同数据的分享图矮（不画但留白是旧行为,必须守住）", () => {
    const oneFilm = [film("a")];
    const oneCrowd = crowd({ a: [1, 0] });
    const red = new Set<RbPosterSection>(["red"]);
    expect(
      rbPosterHeight(buildRbPosterModel(input({ films: oneFilm, crowd: oneCrowd, priorRate: 0.5, sections: red }))),
    ).toBeGreaterThan(rbPosterHeight(rank({ films: oneFilm, crowd: oneCrowd, sections: red })));
  });

  it("两榜都没票 → 一节都不出现（弹层那一拍据此把出图按钮禁用）", () => {
    const model = buildRankPosterModel({ films: [film("a")], crowd: new Map() });
    expect(model.boards).toEqual([]);
  });
});
