// 电影红黑榜纯逻辑单测(2026-09-16,PLAN-20260916102339)。
//
// 为什么单测它:贴纸的「什么时候能贴 / 落在哪 / 排第几」全是纯逻辑判据,
// 判错的后果都是**看得见但说不出哪里不对**,只能靠断言守住:
// ① 红黑各一枚的闸门错 → 同一色贴上两枚,或标记了却发不出贴纸;
// ② 坐标钳制错 → 贴纸贴着画布边缘被裁掉一半;
// ③ 角度不是由 id 推导 → 每次重渲染贴纸都在抖;
// ④ 迁移错 → 旧模型的贴纸在卡片上叠成一坨 / 旧键留着反复复活。
//
// 用内存 localStorage 替身而非 jsdom:被测模块 import 期不碰 localStorage(真机入口才读)。

import { beforeEach, describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import {
  boardFilms,
  clampSpot,
  countsOf,
  crowdOf,
  demoSeed,
  loadStickers,
  loadWatched,
  makeSticker,
  MAX_PER_FILM,
  moveSticker,
  placeSticker,
  saveStickers,
  saveWatched,
  scoreOf,
  sortByCounts,
  spotOf,
  takeSticker,
  tallyOf,
  tiltOf,
  votesOf,
  type CrowdCounts,
  type Sticker,
  type StickerBoard,
} from "../src/redblack";
import { show } from "./helpers";

/** 最小内存 localStorage 替身 —— redblack.ts 直接用全局 localStorage,故挂到 globalThis */
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  get length(): number {
    return mem.size;
  },
  key: (i: number): string | null => [...mem.keys()][i] ?? null,
  getItem: (k: string): string | null => mem.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    mem.set(k, v);
  },
  removeItem: (k: string): void => {
    mem.delete(k);
  },
  clear: (): void => {
    mem.clear();
  },
};

const LS_V2 = "biff.redblack.v2";
const LS_V1 = "biff.redblack.v1";
const LS_WATCHED = "biff.redblack.watched.v1";

/** 最小 FilmNode:只填被测函数真正读的字段 */
function film(key: string, shows: FilmNode["shows"] = []): FilmNode {
  return {
    key,
    title: key,
    en: key,
    zh: key,
    names: [],
    meta: "",
    cats: [],
    shows,
  };
}

function sticker(id: string, type: Sticker["type"], posX = 0.5, posY = 0.5): Sticker {
  return { id, type, posX, posY };
}

beforeEach(() => {
  mem.clear();
});

describe("位置与角度", () => {
  it("坐标钳进安全区(贴纸中心不出画布边缘,免得被裁掉一半)", () => {
    expect(clampSpot(-3, 9)).toEqual({ posX: 0.08, posY: 0.92 });
    expect(clampSpot(0.5, 0.5)).toEqual({ posX: 0.5, posY: 0.5 });
  });

  it("倾斜角由 id 推导:同一枚恒定,落在 ±15° 内,且不是个个端正", () => {
    expect(tiltOf("s-1")).toBe(tiltOf("s-1"));
    const tilts = new Set([...Array(40).keys()].map((i) => tiltOf(`s-${i}`)));
    expect(tilts.size).toBeGreaterThan(1); // 全都一样就没有「手贴」的味道了
    for (const tilt of tilts) expect(Math.abs(tilt)).toBeLessThanOrEqual(15);
  });

  it("确定性落点:同一个 id 每次都一样(迁移旧数据时贴纸不会乱跑)", () => {
    expect(spotOf("k#v1-0")).toEqual(spotOf("k#v1-0"));
    const spot = spotOf("k#v1-0");
    expect(spot.posX).toBeGreaterThanOrEqual(0.08);
    expect(spot.posX).toBeLessThanOrEqual(0.92);
    expect(spot.posY).toBeGreaterThanOrEqual(0.08);
    expect(spot.posY).toBeLessThanOrEqual(0.92);
  });

  it("makeSticker:不给 spot 时落点随机但在安全区内;给了 spot 就用它并钳进安全区", () => {
    const seq = [0.25, 0.9, 0.1];
    let i = 0;
    const s = makeSticker("black", undefined, () => seq[i++ % seq.length]);
    expect(s.type).toBe("black");
    expect(s.id).not.toBe("");
    expect(s.posX).toBeCloseTo(0.08 + 0.9 * 0.84, 6);
    expect(s.posY).toBeCloseTo(0.08 + 0.1 * 0.84, 6);

    // 从暂存区拖到画布上松手 → 落在松手那一点(越界则钳回安全区)
    const dropped = makeSticker("red", { posX: 0.3, posY: 0.4 });
    expect(dropped).toMatchObject({ type: "red", posX: 0.3, posY: 0.4 });
    expect(makeSticker("red", { posX: 5, posY: -5 })).toMatchObject({ posX: 0.92, posY: 0.08 });
  });
});

describe("配额:标记「看过」才发,一部一枚", () => {
  it("没标记 → 不能贴(暂存区那两枚是灰的)", () => {
    expect(tallyOf("cat:f001", false, new Map())).toMatchObject({
      marked: false,
      canPlace: false,
      quota: 0,
    });
  });

  it("标记过且还没贴 → 可以贴,暂存区里红黑二选一", () => {
    expect(tallyOf("cat:f001", true, new Map())).toMatchObject({ canPlace: true, quota: 1 });
  });

  it("贴过一枚(无论红黑)→ 不能再贴,要先把那张拖出去收回", () => {
    const red: StickerBoard = new Map([["cat:f001", [sticker("a", "red")]]] as never);
    expect(tallyOf("cat:f001", true, red)).toMatchObject({ total: 1, canPlace: false, quota: 0 });
    const black: StickerBoard = new Map([["cat:f001", [sticker("b", "black")]]] as never);
    expect(tallyOf("cat:f001", true, black)).toMatchObject({ total: 1, canPlace: false });
  });

  it("取消「看过」标记:不能新贴(已贴的那枚由视图层收回)", () => {
    const board: StickerBoard = new Map([["cat:f001", [sticker("a", "red")]]] as never);
    expect(tallyOf("cat:f001", false, board)).toMatchObject({
      marked: false,
      canPlace: false,
      quota: 0,
    });
  });

  it("红 / 黑分别计数", () => {
    expect(countsOf([sticker("a", "red"), sticker("b", "black")])).toEqual({
      total: 2,
      red: 1,
      black: 1,
    });
  });
});

// 红黑榜评分 = 红贴纸占比折算成 0–10 分(用户 2026-09-16:「通过红黑榜贴纸数量做一个评分」)。
describe("scoreOf:红黑榜评分", () => {
  it("全红 = 10 分,全黑 = 0 分", () => {
    expect(scoreOf({ total: 4, red: 4, black: 0 })).toBe(10);
    expect(scoreOf({ total: 4, red: 0, black: 4 })).toBe(0);
  });

  it("按红占比折算,保留一位小数", () => {
    expect(scoreOf({ total: 3, red: 2, black: 1 })).toBe(6.7);
    expect(scoreOf({ total: 2, red: 1, black: 1 })).toBe(5);
  });

  it("一枚都没贴 → null(显示成「—」,而不是 0 分)", () => {
    expect(scoreOf({ total: 0, red: 0, black: 0 })).toBeNull();
  });
});

// 排序按**全体票数**(服务端聚合)走:红黑榜是大家贴出来的榜,排名自然看大家贴了多少。
describe("排序:三档降序,并列保序", () => {
  const crowd: CrowdCounts = new Map([
    ["a", { total: 1, red: 0, black: 1 }],
    ["b", { total: 1, red: 1, black: 0 }],
  ]);
  const films = ["a", "b", "c", "d"].map((key) => ({ key }));

  it("按总数降序(有票的排前面,并列保序)", () => {
    expect(sortByCounts(films, crowd, "total").map((f) => f.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("红榜:红票在前", () => {
    expect(sortByCounts(films, crowd, "red").map((f) => f.key)).toEqual(["b", "a", "c", "d"]);
  });

  it("黑榜:黑票在前", () => {
    expect(sortByCounts(films, crowd, "black").map((f) => f.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("一票都没有 → 原顺序不变(即影片库默认顺序)", () => {
    expect(sortByCounts(films, new Map(), "total").map((f) => f.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("多票时按票数降序,且三档各按自己的维度", () => {
    const more: CrowdCounts = new Map([
      ["a", { total: 5, red: 4, black: 1 }],
      ["b", { total: 3, red: 1, black: 2 }],
      ["c", { total: 8, red: 0, black: 8 }],
    ]);
    expect(sortByCounts(films, more, "total").map((f) => f.key)).toEqual(["c", "a", "b", "d"]);
    expect(sortByCounts(films, more, "red").map((f) => f.key)).toEqual(["a", "b", "c", "d"]);
    expect(sortByCounts(films, more, "black").map((f) => f.key)).toEqual(["c", "b", "a", "d"]);
  });
});

// 与「服务端全体票数」的对接:读回来的形状转换(crowdOf)与发出去的载荷(votesOf)。
describe("对接服务端票数", () => {
  it("crowdOf:两色都为 0 / 非法值不进 Map;负数夹回 0", () => {
    const crowd = crowdOf({
      a: { red: 3, black: 1 },
      b: { red: 0, black: 0 },
      c: { red: -2, black: 4 },
    });
    expect([...crowd.keys()]).toEqual(["a", "c"]);
    expect(crowd.get("a")).toEqual({ total: 4, red: 3, black: 1 });
    expect(crowd.get("c")).toEqual({ total: 4, red: 0, black: 4 });
    expect(crowdOf({}).size).toBe(0);
  });

  it("votesOf:每部只取那一枚的颜色(一人一部一票)", () => {
    const board: StickerBoard = new Map([
      ["a", [sticker("x", "red")]],
      ["b", [sticker("y", "black")]],
      ["c", []],
    ] as never);
    expect(votesOf(board)).toEqual([
      { key: "a", vote: "red" },
      { key: "b", vote: "black" },
    ]);
  });
});

describe("贴纸变更:不可变 + 红黑各一枚 + 拖动改坐标", () => {
  it("placeSticker 不改原 board;一部一枚:第二枚(任何颜色)都被拦下", () => {
    const board: StickerBoard = new Map();
    const once = placeSticker(board, "a", sticker("s1", "red"));
    expect(board.size).toBe(0);
    expect(once.get("a")).toHaveLength(MAX_PER_FILM);
    expect(placeSticker(once, "a", sticker("s2", "black"))).toBe(once);
    expect(placeSticker(once, "a", sticker("s3", "red"))).toBe(once);
  });

  it("takeSticker 按 id 取下;取空后整条记录删掉", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red"));
    expect(takeSticker(board, "a", "不存在")).toBe(board);
    expect(takeSticker(board, "a", "s1").has("a")).toBe(false);
  });

  it("同卡拖动 → 只改坐标,并钳进安全区", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red", 0.5, 0.5));
    const moved = moveSticker(board, "a", "s1", "a", 2, -1);
    expect(moved.get("a")![0]).toMatchObject({ id: "s1", posX: 0.92, posY: 0.08 });
  });

  it("跨卡拖动:目标空则落位,来源空了就删记录", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red"));
    const moved = moveSticker(board, "a", "s1", "b", 0.3, 0.4);
    expect(moved.has("a")).toBe(false);
    expect(moved.get("b")![0]).toMatchObject({ id: "s1", posX: 0.3, posY: 0.4 });
  });

  it("跨卡拖动:目标卡已经有贴纸 → 原样返回(调用方据此提示)", () => {
    let board = placeSticker(new Map(), "a", sticker("s1", "red"));
    board = placeSticker(board, "b", sticker("s2", "black"));
    expect(moveSticker(board, "a", "s1", "b", 0.2, 0.2)).toBe(board);
  });

  it("来源没有这枚 → 原样返回", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red"));
    expect(moveSticker(board, "a", "不存在", "b", 0.2, 0.2)).toBe(board);
  });
});

describe("持久化:零迁移 + 坏数据兜底", () => {
  it("落盘后读回一致", () => {
    const board = placeSticker(new Map(), "cat:f001", sticker("s1", "black", 0.2, 0.7));
    saveStickers(board);
    expect(loadStickers()).toEqual(board);
  });

  it("「看过」标记独立落盘,与贴纸互不影响", () => {
    saveWatched(new Set(["cat:f001", "cat:f002"]));
    expect(loadWatched()).toEqual(new Set(["cat:f001", "cat:f002"]));
    expect(loadStickers().size).toBe(0);
    saveStickers(placeSticker(new Map(), "cat:f001", sticker("s1", "red")));
    expect(loadWatched().size).toBe(2);
  });

  it("非法条目静默丢弃(类型 / 非数字坐标 / 重复同色 / 缺 id)", () => {
    mem.set(
      LS_V2,
      JSON.stringify({
        "cat:f001": [
          { id: "a", type: "red", posX: 0.5, posY: 0.5 },
          { id: "b", type: "blue", posX: 0.5, posY: 0.5 },
          { id: "c", type: "black", posX: "x", posY: 0.5 },
          { id: "d", type: "black", posX: 0.5 },
          { type: "black", posX: 0.5, posY: 0.5 },
          { id: "e", type: "red", posX: 0.5, posY: 0.5 },
          "不是对象",
        ],
        "cat:f002": [],
        "": [{ id: "x", type: "red", posX: 0.5, posY: 0.5 }],
      }),
    );
    expect(loadStickers()).toEqual(
      new Map([["cat:f001", [{ id: "a", type: "red", posX: 0.5, posY: 0.5 }]]]),
    );
  });

  it("越界坐标在读取时被钳回安全区(旧数据 / 手改的 localStorage)", () => {
    mem.set(LS_V2, JSON.stringify({ a: [{ id: "a", type: "red", posX: -9, posY: 9 }] }));
    expect(loadStickers().get("a")![0]).toMatchObject({ posX: 0.08, posY: 0.92 });
  });

  it("坏 JSON / 键缺失 → 空集合,不抛", () => {
    mem.set(LS_V2, "{坏 JSON");
    mem.set(LS_WATCHED, "{坏 JSON");
    expect(loadStickers().size).toBe(0);
    expect(loadWatched().size).toBe(0);
  });

  it("「看过」标记里的非法项(非字符串 / 空串)被丢掉", () => {
    mem.set(LS_WATCHED, JSON.stringify(["cat:f001", 42, "", null]));
    expect(loadWatched()).toEqual(new Set(["cat:f001"]));
  });
});

// 旧模型(v1:槽位 + `color`)与新模型(v2:自由坐标 + `type`)结构不兼容。
// 为什么单测它:迁移写错的两种后果都很难解释 —— 贴纸全丢,或旧键留着把数据「复活」。
describe("v1 → v2 迁移", () => {
  it("槽位数据被转成安全区内的坐标,当场落盘并删掉旧键", () => {
    mem.set(
      LS_V1,
      JSON.stringify({
        "cat:f001": [
          { color: "red", slot: 0 },
          { color: "black", slot: 17 },
        ],
      }),
    );
    const board = loadStickers();
    const list = board.get("cat:f001")!;
    // 旧数据里那一部有红黑两枚 —— 新的「一部一枚」口径下只留第一枚
    expect(list.map((s) => s.type)).toEqual(["red"]);
    for (const s of list) {
      expect(s.id).not.toBe("");
      expect(s.posX).toBeGreaterThanOrEqual(0.08);
      expect(s.posX).toBeLessThanOrEqual(0.92);
    }
    // 迁移当场落盘 + 旧键删除:否则 v2 一旦缺失,旧数据会再被读一次(「数据复活」)
    expect(mem.has(LS_V2)).toBe(true);
    expect(mem.has(LS_V1)).toBe(false);
  });

  it("v2 已有数据时不看 v1(旧键留着也不影响)", () => {
    mem.set(LS_V1, JSON.stringify({ old: [{ color: "red", slot: 1 }] }));
    saveStickers(placeSticker(new Map(), "new", sticker("s1", "red")));
    expect([...loadStickers().keys()]).toEqual(["new"]);
  });

  it("旧数据里同一部多枚 → 只留第一枚(一部一枚)", () => {
    mem.set(
      LS_V1,
      JSON.stringify({ a: [{ color: "red", slot: 1 }, { color: "black", slot: 9 }] }),
    );
    expect(loadStickers().get("a")).toHaveLength(MAX_PER_FILM);
  });
});

describe("boardFilms:只列有排期的影片", () => {
  it("无排期的目录片不入榜(连场次都没有,谈不上看过没看过)", () => {
    const withShows = film("a", [show({ code: "001" })]);
    const noShows = film("b", []);
    expect(boardFilms([withShows, noShows]).map((f) => f.key)).toEqual(["a"]);
  });
});

// 示例铺底(2026-09-16):空榜看不出颜色分布 / 排序 / 拖拽的效果,首次进入先铺一份内存态示例。
// 为什么单测它:它是**唯一**会往用户数据里「凭空多出内容」的路径,判错的后果是
// 「用户没标记却看到一堆贴纸」或「用户自己弄的被示例覆盖」,两种都很难解释。
describe("demoSeed:示例铺底", () => {
  const films = [...Array(9).keys()].map((i) => film(`f${i}`, [show({ code: `s${i}` })]));

  it("确定性:同一份影片每次生成完全一样", () => {
    expect(demoSeed(films)).toEqual(demoSeed(films));
  });

  it("用户已有的内容原样保留,只补他没有的影片", () => {
    const mine: StickerBoard = new Map([["f1", [sticker("mine", "black", 0.3, 0.3)]]] as never);
    const seed = demoSeed(films, 60, mine, new Set(["f2"]));
    expect(seed.board.get("f1")).toEqual([{ id: "mine", type: "black", posX: 0.3, posY: 0.3 }]);
    expect(seed.watched.has("f2")).toBe(true);
  });

  it("三段循环:留白 / 已贴 / 待贴 都出现(否则看不出差别)", () => {
    const seed = demoSeed(films);
    const placed = [...seed.board.values()].filter((l) => l.length > 0).length;
    expect(placed).toBeGreaterThan(0);
    expect(seed.watched.size).toBeGreaterThan(placed); // 有标记了但还没贴的
    expect(seed.watched.size).toBeLessThan(films.length); // 也有留白让用户自己点
  });

  it("坐标合法、每部不超过一枚、红黑都出现(清一色的话三档排序看不出差别)", () => {
    const seed = demoSeed(films);
    const all = [...seed.board.values()].flat();
    for (const s of all) {
      expect(s.posX).toBeGreaterThanOrEqual(0.08);
      expect(s.posX).toBeLessThanOrEqual(0.92);
      expect(s.id).not.toBe("");
    }
    for (const list of seed.board.values()) expect(list.length).toBeLessThanOrEqual(MAX_PER_FILM);
    expect(all.some((s) => s.type === "red")).toBe(true);
    expect(all.some((s) => s.type === "black")).toBe(true);
  });
});
