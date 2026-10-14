// 快速投票的**纯逻辑**（2026-10-14，PLAN-20261014190000）。
//
// 为什么单测它：这一层是「左滑算什么」与「候选是谁」的**唯一**实现，而它恰好是整条链路上
// 唯一不依赖浏览器的那一段 —— 视图层只负责把这里定好的意图演出来。
// 方向判定的两种错法都很难在界面上看出来：判松了（阈值太小）会把「想上下扫一眼简介」读成一次投票；
// 判紧了（差 1px 不认）会让用户划到底还是弹回来。所以把阈值与主轴占优都钉住。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import {
  axisVote,
  deckStateOf,
  quickVoteOrder,
  resolveSwipe,
  SWIPE_RATIO,
  voteStateLabel,
} from "../src/quick-vote";

const UNIT = 300;
const LIMIT = UNIT * SWIPE_RATIO; // 84px

/** 只造这一层用得到的字段：`shows` 里只要有 date / start_time（`quickVoteOrder` 唯一读的两项）。 */
function film(key: string, shows: Array<[string, string]> = []): FilmNode {
  return {
    key,
    title: key,
    en: key,
    zh: key,
    names: [],
    meta: "",
    cats: [],
    shows: shows.map(([date, start_time]) => ({ date, start_time })) as never,
  };
}

describe("resolveSwipe:位移 → 方向", () => {
  it("不到阈值 → null（卡片弹回原位，什么状态都不改）", () => {
    expect(resolveSwipe(LIMIT - 1, 0, UNIT)).toBeNull();
    expect(resolveSwipe(0, -(LIMIT - 1), UNIT)).toBeNull();
  });

  it("左右各认一边", () => {
    expect(resolveSwipe(LIMIT, 0, UNIT)).toBe("right");
    expect(resolveSwipe(-LIMIT, 0, UNIT)).toBe("left");
  });

  it("只有**向上**有含义：向下滑同样是 null", () => {
    expect(resolveSwipe(0, -LIMIT, UNIT)).toBe("up");
    expect(resolveSwipe(0, LIMIT, UNIT)).toBeNull();
  });

  it("斜滑（两轴接近）→ null，不猜", () => {
    // 90 / 88：都过了阈值，但谁也压不过谁 —— 判给哪一边都是把「随便一划」变成一次投票
    expect(resolveSwipe(-90, -88, UNIT)).toBeNull();
  });

  it("主轴明显占优 → 按主轴判", () => {
    expect(resolveSwipe(-100, -40, UNIT)).toBe("left");
    expect(resolveSwipe(-40, -100, UNIT)).toBe("up");
  });

  it("★ unit = 0（首帧 / 隐藏容器）→ 一律 null", () => {
    // 不夹这一下的话 limit = 0，任何一个像素的位移都会被判成一次投票
    expect(resolveSwipe(500, 0, 0)).toBeNull();
    expect(resolveSwipe(0, -500, 0)).toBeNull();
  });
});

describe("axisVote:方向 → 写什么", () => {
  it("左 = 黑、右 = 红", () => {
    expect(axisVote("left")).toBe("black");
    expect(axisVote("right")).toBe("red");
  });

  it("★ 上 = null —— 这就是「跳过不写任何状态」那句话的唯一实现", () => {
    // 调用方收到 null 必须**一个字节都不写**（用户口径：跳过不覆盖原有评价）
    expect(axisVote("up")).toBeNull();
  });
});

describe("quickVoteOrder:候选与顺序", () => {
  const films = [
    film("cat:a", [["2026-10-10", "12:00"]]),
    film("cat:b", [["2026-10-08", "20:00"]]),
    film("cat:c", []), // 目录片：没有场次
  ];

  it("只留行程里的那些，别的片一个都不进来", () => {
    const queue = quickVoteOrder(films, new Set(["cat:a"]));
    expect(queue.map((f) => f.key)).toEqual(["cat:a"]);
  });

  it("按**我在行程里最早的那一场**升序", () => {
    const queue = quickVoteOrder(films, new Set(["cat:a", "cat:b"]));
    expect(queue.map((f) => f.key)).toEqual(["cat:b", "cat:a"]);
  });

  it("没有场次的目录片排在最后（有排期的先看）", () => {
    const queue = quickVoteOrder(films, new Set(["cat:a", "cat:b", "cat:c"]));
    expect(queue.map((f) => f.key)).toEqual(["cat:b", "cat:a", "cat:c"]);
  });

  it("行程为空 → 空数组（兜底交给调用方，纯函数不猜数据来源）", () => {
    expect(quickVoteOrder(films, new Set())).toEqual([]);
  });

  it("★ 已投过的片子照样在队列里（它本来就是改票的入口）", () => {
    // 这一条是**故意的**：候选只看「在不在我的行程」，不看「投过没有」
    const queue = quickVoteOrder(films, new Set(["cat:b", "cat:c"]));
    expect(queue.map((f) => f.key)).toEqual(["cat:b", "cat:c"]);
  });
});

describe("deckStateOf / voteStateLabel:对外那三个词", () => {
  it("红 = liked、黑 = passed、没有 = undecided", () => {
    expect(deckStateOf("red")).toBe("liked");
    expect(deckStateOf("black")).toBe("passed");
    expect(deckStateOf(undefined)).toBe("undecided");
  });

  it("文案与状态一一对应（未决定也要说得出话）", () => {
    expect(voteStateLabel("red")).toBe("已投红榜");
    expect(voteStateLabel("black")).toBe("已投黑榜");
    expect(voteStateLabel(undefined)).toBe("还没决定");
  });
});
