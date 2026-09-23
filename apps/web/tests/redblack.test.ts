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
  countsSignature,
  crowdOf,
  crowdSignature,
  crowdStickers,
  loadStickers,
  loadWatched,
  makeSticker,
  MAX_PER_FILM,
  moveSticker,
  placeSticker,
  purgeDemoLeavings,
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
/** 废弃键:原来记「已关掉示例铺底」,现在只被清理函数删掉 */
const LS_SEEN = "biff.redblack.seen.v1";

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

// 画布上「别人的贴纸」怎么画(2026-09-22,PLAN-20260922142903 → PLAN-20260922145815)。
// 为什么单测它:画布画的是**别人的票数**,画错只会表现为「数字和画面看着不一样」,
// 没有异常、没有报错 —— 只能靠断言守住:
// ① 曾经的「按比例取整」会把**少数派**抹掉 → 卡片写着「红 1」而画布上一个红点都没有;
// ② 曾经的每卡 16 枚上限 → 画布密度与真实票数脱钩(用户把 16 读成真实票数)。
// 现在口径是**票数几枚就画几枚**,所以断言写成「画出来的红黑构成与计数逐一对上」。
describe("别人的贴纸:票数几枚就画几枚", () => {
  it("全量画:3 红 / 2 黑 → 恰恰 3 红 2 黑", () => {
    const dots = crowdStickers("a", { total: 5, red: 3, black: 2 });
    expect(dots).toHaveLength(5);
    expect(dots.filter((d) => d.type === "red")).toHaveLength(3);
    expect(dots.filter((d) => d.type === "black")).toHaveLength(2);
  });

  it("少数派不会被抹掉:1 红 / 100 黑 也画得出那一枚红", () => {
    const dots = crowdStickers("a", { total: 101, red: 1, black: 100 });
    expect(dots).toHaveLength(101);
    expect(dots.filter((d) => d.type === "red")).toHaveLength(1);
    expect(dots.filter((d) => d.type === "black")).toHaveLength(100);
  });

  it("反向同理(100 红 / 1 黑)", () => {
    const dots = crowdStickers("a", { total: 101, red: 100, black: 1 });
    expect(dots.filter((d) => d.type === "black")).toHaveLength(1);
    expect(dots.filter((d) => d.type === "red")).toHaveLength(100);
  });

  it("纯色不夹取:全黑时不能凭空多出一枚红", () => {
    const dots = crowdStickers("a", { total: 40, red: 0, black: 40 });
    expect(dots.filter((d) => d.type === "red")).toHaveLength(0);
    expect(dots).toHaveLength(40);
  });

  it("计数是脏数据时也不越界:red 比 total 还大 → 全部按红画,但不多画", () => {
    const dots = crowdStickers("a", { total: 3, red: 99, black: 0 });
    expect(dots).toHaveLength(3);
    expect(dots.filter((d) => d.type === "red")).toHaveLength(3);
  });

  it("没票 / 未收录 → 一枚不画", () => {
    expect(crowdStickers("a", undefined)).toEqual([]);
    expect(crowdStickers("a", { total: 0, red: 0, black: 0 })).toEqual([]);
  });

  it("位置稳定:同一份计数两次调用落点完全一致(否则重排时点会乱跳)", () => {
    const input = { total: 9, red: 5, black: 4 };
    expect(crowdStickers("a", input)).toEqual(crowdStickers("a", input));
  });
});

// 落点的**分布**(2026-09-22,PLAN-20260922145815 修订 2)。
// 为什么单测它:落点直接拿 FNV 哈希的高位算,而同一部片的 id 共享前缀(`cat:f001#crowd-`),
// 高位对末尾那几个字符几乎不敏感 —— 100 枚会挤成一条横带,个别片甚至全落在上面 40% 里。
// 一天只画 16 枚时看不出来,放开上限后一眼就是「没铺满」;而它既不会报错也不会崩,只能靠断言守。
describe("spotOf:落点要真的铺开", () => {
  const spread = (key: string, axis: "posX" | "posY") => {
    const values = Array.from({ length: 100 }, (_, i) => spotOf(`${key}#crowd-${i}`)[axis]);
    values.sort((a, b) => a - b);
    return { span: values[99] - values[0], median: values[50] };
  };

  it("100 枚的纵坐标铺满画布,不是一条横带", () => {
    const { span, median } = spread("cat:f001", "posY");
    expect(span).toBeGreaterThan(0.5);
    expect(Math.abs(median - 0.5)).toBeLessThan(0.2);
  });

  it("横坐标同理", () => {
    const { span, median } = spread("cat:f001", "posX");
    expect(span).toBeGreaterThan(0.5);
    expect(Math.abs(median - 0.5)).toBeLessThan(0.2);
  });

  it("换几部片都铺得开(不是那部片碰巧对)", () => {
    for (const key of ["cat:f007", "cat:f020", "cat:f137"]) {
      expect(spread(key, "posY").span).toBeGreaterThan(0.5);
      expect(spread(key, "posX").span).toBeGreaterThan(0.5);
    }
  });
});

// 「有新贴纸 · 重新排序」的判据(2026-09-22,PLAN-20260922142903)。
// 为什么单测它:重拉一次票数就会得到**新对象**,拿引用比会让提示在「数量没变」时也白亮一次
// —— 表现只是「提示莫名出现」,没有报错,只能靠断言守住「只有数量变了才算」。
describe("crowdSignature:票数是不是真的变了", () => {
  it("内容相同 → 签名相同(重拉票数不该算「有新贴纸」)", () => {
    const before: CrowdCounts = new Map([["a", { total: 3, red: 2, black: 1 }]]);
    const after: CrowdCounts = new Map([["a", { total: 3, red: 2, black: 1 }]]);
    expect(after).not.toBe(before);
    expect(crowdSignature(after)).toBe(crowdSignature(before));
  });

  it("总数变了 → 签名变了(该提示重排)", () => {
    const before: CrowdCounts = new Map([["a", { total: 3, red: 2, black: 1 }]]);
    const after: CrowdCounts = new Map([["a", { total: 4, red: 3, black: 1 }]]);
    expect(crowdSignature(after)).not.toBe(crowdSignature(before));
  });

  it("总数不变但红黑互换 → 签名也变(红榜 / 黑榜各有各的判据)", () => {
    const before: CrowdCounts = new Map([["a", { total: 3, red: 2, black: 1 }]]);
    const after: CrowdCounts = new Map([["a", { total: 3, red: 1, black: 2 }]]);
    expect(crowdSignature(after)).not.toBe(crowdSignature(before));
  });

  it("多了 / 少了一部片 → 签名变了", () => {
    const before: CrowdCounts = new Map([["a", { total: 1, red: 1, black: 0 }]]);
    const after: CrowdCounts = new Map([
      ["a", { total: 1, red: 1, black: 0 }],
      ["b", { total: 2, red: 0, black: 2 }],
    ]);
    expect(crowdSignature(after)).not.toBe(crowdSignature(before));
  });

  it("条目顺序变了 → 签名不变(只看内容,服务端换序不算变)", () => {
    const a: CrowdCounts = new Map([
      ["a", { total: 1, red: 1, black: 0 }],
      ["b", { total: 2, red: 0, black: 2 }],
    ]);
    const b: CrowdCounts = new Map([
      ["b", { total: 2, red: 0, black: 2 }],
      ["a", { total: 1, red: 1, black: 0 }],
    ]);
    expect(crowdSignature(b)).toBe(crowdSignature(a));
  });

  it("空表 → 空签名(榜上还没人贴时提示不亮)", () => {
    expect(crowdSignature(new Map())).toBe("");
  });
});

// 单部票数的签名 —— 画布的重绘守护拿它当判据(PLAN-20260922145815)。
// 与上面同一个坑:`counts` 每次 render 都是新对象,按引用比会让每次 re-render 都白重画一遍。
describe("countsSignature:一部片的票数签名", () => {
  it("按值:两个内容相同的新对象签名相同", () => {
    const before = { total: 3, red: 2, black: 1 };
    const after = { total: 3, red: 2, black: 1 };
    expect(after).not.toBe(before);
    expect(countsSignature(after)).toBe(countsSignature(before));
  });

  it("总数变 / 红黑互换 → 签名都变(画布与红黑榜都得重画)", () => {
    const base = { total: 3, red: 2, black: 1 };
    expect(countsSignature({ total: 4, red: 3, black: 1 })).not.toBe(countsSignature(base));
    expect(countsSignature({ total: 3, red: 1, black: 2 })).not.toBe(countsSignature(base));
  });
});

describe("贴纸变更:不可变 + 红黑各一枚 + 拖动只在本片改坐标", () => {
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

  it("挪位置 → 只改坐标,并钳进安全区", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red", 0.5, 0.5));
    const moved = moveSticker(board, "a", "s1", 2, -1);
    expect(moved.get("a")![0]).toMatchObject({ id: "s1", posX: 0.92, posY: 0.08 });
  });

  // 张贴区**按片独立**(2026-09-23 用户:「贴纸张贴区应该是电影之间独立的」)。
  // 旧版 `moveSticker` 收一个 `toKey`:拖到别片的画布上就把这一票**直接改记到别片头上** ——
  // 那条路径已删,现在它连参数都不接受跨片(所以这里只能断言「挪自己那枚不会动别片」);
  // 「跨片拖拽不落到别片」由 E2E 守:`e2e/react/redblack.spec.ts`。
  it("挪位置只动本片这一枚:别片的记录原封不动", () => {
    let board = placeSticker(new Map(), "a", sticker("s1", "red", 0.5, 0.5));
    board = placeSticker(board, "b", sticker("s2", "black", 0.5, 0.5));
    const moved = moveSticker(board, "a", "s1", 0.9, 0.1);
    expect(moved.get("a")).toEqual([{ id: "s1", type: "red", posX: 0.9, posY: 0.1 }]);
    expect(moved.get("b")).toEqual([{ id: "s2", type: "black", posX: 0.5, posY: 0.5 }]);
  });

  it("来源没有这枚 → 原样返回", () => {
    const board = placeSticker(new Map(), "a", sticker("s1", "red"));
    expect(moveSticker(board, "a", "不存在", 0.2, 0.2)).toBe(board);
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

// 示例残留清理(2026-09-16):早先版本首次进入会自动铺一份示例贴纸,用户要求正式环境从空榜开始。
// 为什么单测它:这是**唯一**会动用户已有数据的清理路径,判错的两种后果都很难解释 ——
// 「用户自己贴的被一起删掉」或「示例一直清不掉、用户永远顶着一堆没贴过的贴纸」。
describe("purgeDemoLeavings:清理示例残留", () => {
  it("没有示例残留 → 原样返回,一个字节都不动", () => {
    const mine = placeSticker(new Map(), "cat:f001", sticker("s1", "red", 0.3, 0.3));
    saveStickers(mine);
    saveWatched(new Set(["cat:f002"]));
    const result = purgeDemoLeavings();
    expect(result.board).toEqual(mine);
    expect(result.watched).toEqual(new Set(["cat:f002"]));
  });

  it("贴纸全是示例生成的 → board 与 watched 一起清空(整份都是自动铺的)", () => {
    saveStickers(placeSticker(new Map(), "cat:f001", sticker("demo-cat:f001-red", "red")));
    saveWatched(new Set(["cat:f001", "cat:f002"]));
    const result = purgeDemoLeavings();
    expect(result.board.size).toBe(0);
    expect(result.watched.size).toBe(0);
    // 当场落盘:只清内存的话刷新一次示例又回来了
    expect(loadStickers().size).toBe(0);
    expect(loadWatched().size).toBe(0);
  });

  it("混着自己贴的 → 只摘示例那几枚,用户自己的贴纸与标记原样保留", () => {
    let board = placeSticker(new Map(), "cat:f001", sticker("demo-cat:f001-red", "red"));
    board = placeSticker(board, "cat:f002", sticker("s-mine", "black", 0.4, 0.6));
    saveStickers(board);
    saveWatched(new Set(["cat:f002"]));
    const result = purgeDemoLeavings();
    expect([...result.board.keys()]).toEqual(["cat:f002"]);
    expect(result.board.get("cat:f002")).toEqual([
      { id: "s-mine", type: "black", posX: 0.4, posY: 0.6 },
    ]);
    expect(result.watched).toEqual(new Set(["cat:f002"]));
    expect(loadStickers().has("cat:f001")).toBe(false);
  });

  it("顺手收掉废弃的「关掉示例」键(功能已删,留着只是垃圾)", () => {
    mem.set(LS_SEEN, "off");
    purgeDemoLeavings();
    expect(mem.has(LS_SEEN)).toBe(false);
  });
});
