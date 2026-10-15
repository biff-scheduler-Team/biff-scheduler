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
  deckSignature,
  deckSourceLabel,
  deckStateOf,
  pendingQueue,
  quickVoteOrder,
  resolveSwipe,
  SWIPE_RATIO,
  voteStateLabel,
  voteUrl,
  votedQueue,
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

  it("★ 候选只看「在不在我的行程」，**不看投过没有**", () => {
    // 这一层是**候选来源**；「已处理的片不再出现」是 `pendingQueue` 的事（2026-10-14 修订 5）。
    // 两件事分开的原因：候选是「我可能想看的片」，已处理是「我已经翻过的那几张」——
    // 混成一个函数的话，「再划一遍」（要拿回全量候选）就没有入口了。
    const queue = quickVoteOrder(films, new Set(["cat:b", "cat:c"]));
    expect(queue.map((f) => f.key)).toEqual(["cat:b", "cat:c"]);
  });
});

describe("votedQueue:默认候选 = 全站有过票的影片", () => {
  // 2026-10-15（PLAN-20261015005652）。用户的四条里，这条是「默认直接所有有过票的都作为滑动的片单」。
  const films = [
    film("cat:a", [["2026-10-10", "12:00"]]),
    film("cat:b", [["2026-10-08", "20:00"]]),
    film("cat:c", []), // 目录片：没有场次
    film("cat:d", [["2026-10-12", "09:00"]]),
  ];

  it("只收有票的，没票的一个都不进来", () => {
    const voted = new Set(["cat:a", "cat:d"]);
    const queue = votedQueue(films, (key) => voted.has(key));
    expect(queue.map((f) => f.key)).toEqual(["cat:a", "cat:d"]);
  });

  it("顺序与 `quickVoteOrder` **同一套**（最早一场升序，目录片排最后）", () => {
    // 两个来源共用 `orderedByFirstScreening`：顺序口径一旦分叉，「换成我的行程」就会把
    // 用户划到的位置甩到别处 —— 这条同时钉住「同一组 key 一定得到同一个顺序」。
    const keys = new Set(["cat:a", "cat:b", "cat:c"]);
    expect(votedQueue(films, (key) => keys.has(key)).map((f) => f.key)).toEqual(
      quickVoteOrder(films, keys).map((f) => f.key),
    );
    expect(votedQueue(films, (key) => keys.has(key)).map((f) => f.key)).toEqual([
      "cat:b",
      "cat:a",
      "cat:c",
    ]);
  });

  it("★ 顺序**与票数多少无关** —— 票数一变不能换队列", () => {
    // 反例写在这里：`cat:a` 有 99 票、`cat:b` 只有 1 票。
    // 按票数降序（很容易想到、也很容易顺手加上去的那一条）会得到 ["cat:a", "cat:b"]；
    // 而票数一变顺序就变 —— `deckSignature` 判的是 key 序列 ⇒ 卡片被甩回第 1 张
    // （用户报过的 5/50 → 1/50）。所以判据必须是**片单本身**：最早一场升序。
    const counts: Record<string, number> = { "cat:a": 99, "cat:b": 1 };
    const queue = votedQueue(films, (key) => (counts[key] ?? 0) > 0);
    expect(queue.map((f) => f.key)).toEqual(["cat:b", "cat:a"]);
  });

  it("一票都没有 → 空数组（兜底交给调用方，纯函数不猜数据来源）", () => {
    expect(votedQueue(films, () => false)).toEqual([]);
  });
});

describe("deckSourceLabel:候选来源的说法", () => {
  it("三个来源各有一句话（切换按钮 / 来源说明条读它）", () => {
    expect(deckSourceLabel("voted")).toBe("全部有票的影片");
    expect(deckSourceLabel("agenda")).toBe("我的行程");
    expect(deckSourceLabel("hot")).toBe("热门榜 TOP 50");
  });
});

describe("pendingQueue:一轮开始时去掉**已经处理过**的片", () => {
  const films = [film("cat:a"), film("cat:b"), film("cat:c")];

  it("已投过（board 里有）与已跳过（本地标记）都不再进队列", () => {
    const skipped = new Set(["cat:b"]);
    const voted = new Set(["cat:c"]);
    const queue = pendingQueue(films, (key) => skipped.has(key) || voted.has(key));
    expect(queue.map((f) => f.key)).toEqual(["cat:a"]);
  });

  it("一部都没处理过 → 原样（且保持传入的顺序）", () => {
    expect(pendingQueue(films, () => false).map((f) => f.key)).toEqual(["cat:a", "cat:b", "cat:c"]);
  });

  it("★ 全处理完 → 空数组（界面据此说「都划过了」而不是「行程是空的」）", () => {
    expect(pendingQueue(films, () => true)).toEqual([]);
  });
});

describe("deckSignature:队列的「内容身份」", () => {
  it("★ 内容相同、数组引用不同 → 签名相同（5/50 → 1/50 的回归）", () => {
    // 用户报的 bug：投一票 → 上报成功 → 票数聚合换引用 → 队列**重算成新数组** →
    // 卡片的 `useEffect` 判成「候选换了」→ 划到第 6 张被甩回第 1 张。
    // 判据必须是**内容**：引用变了但 key 序列没变时，卡片不该重开这一轮。
    const before = [film("cat:a"), film("cat:b")];
    const after = [film("cat:a"), film("cat:b")];
    expect(after).not.toBe(before);
    expect(deckSignature(after)).toBe(deckSignature(before));
  });

  it("顺序变了 / 成员变了 → 签名必须不同（真的换了一轮就要重开）", () => {
    const base = deckSignature([film("cat:a"), film("cat:b")]);
    expect(deckSignature([film("cat:b"), film("cat:a")])).not.toBe(base);
    expect(deckSignature([film("cat:a")])).not.toBe(base);
    expect(deckSignature([])).not.toBe(base);
  });

  it("空队列的签名是空串（等价于 EMPTY_DECK 那份常量）", () => {
    expect(deckSignature([])).toBe("");
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

describe("voteUrl:扫码投票那条链接", () => {
  // 2026-10-14（PLAN-20261014205414）。两个参数都不能少：
  //   `sort=red` —— 扫码的人落地的档位（`BoardPage::readTab` 的缺省是热门榜）；
  //   `vote=1`   —— 当场弹出快速投票卡片；而 `BoardPage` 的落地 effect **只在 `sort` 缺失时**
  //                 才决定缺省档，所以两个都得写全，否则「扫码 → 卡片根本没挂载」。
  it("带上 sort 与 vote，且用调用方给的 origin", () => {
    expect(voteUrl("https://biff.lcandy.co")).toBe(
      "https://biff.lcandy.co/redblack?sort=red&vote=1",
    );
  });

  it("origin 原样拼接，不在这里猜域名", () => {
    expect(voteUrl("http://localhost:5173")).toBe("http://localhost:5173/redblack?sort=red&vote=1");
  });
});
