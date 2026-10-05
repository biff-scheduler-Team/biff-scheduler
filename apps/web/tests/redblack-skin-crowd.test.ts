// 群点的**按款分布**（2026-09-29，PLAN-20260929195500 第三轮）。
//
// 背景：贴纸外观从「按 id 自动交替」改成「每枚手选一款皮肤」之后，展板上**别人的**贴纸
// 也得长得像他们各自选的那一款 —— 那份信息由服务端按款聚合回来（`peekFilmSkins`）。
//
// 这里守的是三件事，每一件错了都**不会报错**、只有人眼能看出来：
//   ① 分布要真的被用上（而不是悄悄退回「按 id 兜底」）；
//   ② 两本账对不上时**不能丢票**（服务端的总数是权威，按款聚合只覆盖带款的那部分，
//      差额必须按 id 兜底补满 —— 少了就是「群点比数字少」）；
//   ③ 我自己那一枚必须从分布里扣掉（不扣就是「群点比数字多一枚」，而且多出来的那枚
//      恰好是我的款与色，看起来特别合理）。

import { describe, expect, it } from "vitest";

import {
  crowdStickers,
  derivedSkin,
  othersSkins,
  skinsSignature,
  type SkinCrowdCounts,
  type Sticker,
  type SyncedStickerFace,
} from "../src/redblack";
import { STICKER_SKIN_KEYS } from "@biff/contracts/sticker";
import { ALL_SKINS } from "../src/sticker-skin";

/** 数一数这一组群点里各款各有多少枚。 */
function tally(list: readonly Sticker[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sticker of list) {
    const skin = sticker.skin ?? "?";
    out[skin] = (out[skin] ?? 0) + 1;
  }
  return out;
}

describe("crowdStickers：按服务端的款分布铺", () => {
  it("★ 分布被真的用上了（而不是一律按 id 兜底）", () => {
    const counts = { total: 5, red: 3, black: 2 };
    // ⚠ 分布里这两款**不能撞上** `derivedSkin("cat:f001#crowd-2")`：兜底那枚的款由 id 哈希定
    //   （这里是 `scrap`），撞上的话 tally 会把它并进同一桶 —— 那条断言就变成看运气。
    const skins: SkinCrowdCounts = { stub: { red: 2, black: 0 }, sprocket: { red: 0, black: 2 } };
    expect(tally(crowdStickers("cat:f001", counts, skins))).toEqual({
      stub: 2,
      sprocket: 2,
      // 红 3 枚里只有 2 枚带款，差的那一枚按 id 兜底
      [derivedSkin("cat:f001#crowd-2")]: 1,
    });
  });

  it("★ 差额按 id 兜底：**一枚都不许丢**（服务端总数是权威，聚合只覆盖带款的）", () => {
    // 5 票，但按款聚合只认得 1 枚（迁移前的旧票没有款）
    const counts = { total: 5, red: 5, black: 0 };
    const list = crowdStickers("cat:f001", counts, { sprocket: { red: 1, black: 0 } });
    expect(list).toHaveLength(5);
    // ⚠ **不数** `tally().sprocket === 1`（2026-09-30 换款时红过一次）：id 兜底款由 id 哈希决定，
    //   它**可能正好撞上**服务端分布里的那一款 —— 撞不撞是「款 id 表」内容的巧合，
    //   不是这条用例要守的东西。要守的是「一枚都不丢」+「每枚要么是分布里的款、要么是 id 兜底」。
    for (const sticker of list) {
      expect(["sprocket", derivedSkin(sticker.id)]).toContain(sticker.skin);
    }
  });

  it("★ 分布比总数还多（两次独立查询的快照差一拍）→ 按 total 截断，不多画", () => {
    const counts = { total: 2, red: 2, black: 0 };
    const list = crowdStickers("cat:f001", counts, { stub: { red: 9, black: 0 } });
    expect(list).toHaveLength(2);
  });

  it("没有分布数据（老接口 / 还没拉到）→ 全部按 id 兜底，总数照旧", () => {
    const counts = { total: 4, red: 2, black: 2 };
    const list = crowdStickers("cat:f001", counts, undefined);
    expect(list).toHaveLength(4);
    for (const sticker of list) expect(sticker.skin).toBe(derivedSkin(sticker.id));
  });

  it("款只铺在它自己那一色上（红的款不该出现在黑贴上）", () => {
    const counts = { total: 2, red: 1, black: 1 };
    const list = crowdStickers("cat:f001", counts, { stub: { red: 0, black: 1 } });
    const stubSticker = list.find((s) => s.skin === "stub");
    expect(stubSticker?.type).toBe("black");
  });

  it("id 与位置仍**只由序号决定**（分布变了也不该让其它贴纸挪位置）", () => {
    const counts = { total: 3, red: 2, black: 1 };
    const before = crowdStickers("cat:f001", counts, { stub: { red: 2, black: 0 } });
    const after = crowdStickers("cat:f001", counts, { scrap: { red: 2, black: 0 } });
    // 同一个序号 = 同一个 id = 同一个落点
    for (let i = 0; i < counts.total; i += 1) {
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].posX).toBe(before[i].posX);
      expect(after[i].posY).toBe(before[i].posY);
    }
  });
});

describe("othersSkins：把**服务端已确认**的我那一枚从分布里扣掉", () => {
  /** 服务端那份快照里，我这一票长什么样（色 + 款）。 */
  const face = (skin: (typeof ALL_SKINS)[number] | null, type: "red" | "black"): SyncedStickerFace => ({
    type,
    skin,
  });

  it("★ 扣掉我那一桶（款 + 色都要对）", () => {
    const before: SkinCrowdCounts = { stub: { red: 3, black: 1 } };
    expect(othersSkins(before, face("stub", "red"))).toEqual({ stub: { red: 2, black: 1 } });
  });

  it("★ 换款当拍（服务端那份里还是旧款）→ 只扣旧款那一桶，别人新款一枚不少", () => {
    // 服务端分布：我这一枚还是 `stub`（换款那条上报还没落地），另有**别人**的 2 枚 `scrap`。
    const before: SkinCrowdCounts = { stub: { red: 1, black: 0 }, scrap: { red: 2, black: 0 } };
    // 用户刚把本地那枚换成 `scrap`，而**服务端已确认的**那一面仍是 `stub` —— 扣减必须以它为准。
    expect(othersSkins(before, face("stub", "red"))).toEqual({
      stub: { red: 0, black: 0 },
      // ⚠ 这一条是本次修复的要害：别人的 `scrap` **一枚都不能少**。
      //   改前拿**本地当前款**去扣，结果会是 `stub:{red:1}` + `scrap:{red:1}` ——
      //   一边凭空多出一枚我的旧款（像别人贴的），一边把别人的新款扣掉一枚，
      //   就是用户 2026-10-05 报的「换自己的皮肤，把红黑榜别人的皮肤也换了」。
      scrap: { red: 2, black: 0 },
    });
  });

  it("服务端那份里没有我（还没确认 / 是没带款的老票）→ 原样不动", () => {
    const before: SkinCrowdCounts = { stub: { red: 3, black: 1 } };
    expect(othersSkins(before, undefined)).toBe(before);
    // ⚠ 没有款（迁移前的旧票）时服务端按款聚合里**根本没有我这一桶** —— 不能按 id 兜底去扣，
    //   那会从**别人的**桶里扣掉一枚（与上面那条 bug 是同一种形状）。
    expect(othersSkins(before, face(null, "red"))).toBe(before);
  });

  it("分布里没有我那一款 → 原样返回（那不是错误）", () => {
    const before: SkinCrowdCounts = { stub: { red: 3, black: 1 } };
    expect(othersSkins(before, face("scrap", "red"))).toBe(before);
  });

  it("桶已经空了 → 不扣成负数", () => {
    const before: SkinCrowdCounts = { stub: { red: 0, black: 1 } };
    expect(othersSkins(before, face("stub", "red"))).toBe(before);
  });

  it("没有分布数据（老接口）→ 原样返回，让画布走「按 id 兜底」那条分支", () => {
    expect(othersSkins(undefined, face("stub", "red"))).toBeUndefined();
  });
});

describe("skinsSignature：画布重绘的判据", () => {
  it("★ 只换了一款（两色总数一个都没动）也要变 —— 否则画面停在旧分布上", () => {
    const before: SkinCrowdCounts = { stub: { red: 2, black: 0 } };
    const after: SkinCrowdCounts = { scrap: { red: 2, black: 0 } };
    expect(skinsSignature(after)).not.toBe(skinsSignature(before));
  });

  it("某一款归零也要变（不能因为「键没了」就与「一直是 0」撞上）", () => {
    expect(skinsSignature({ stub: { red: 0, black: 0 } })).not.toBe(skinsSignature({}));
  });

  it("内容一样 → 签名一样（否则每次拉取都会白重画一遍）", () => {
    expect(skinsSignature({ stub: { red: 1, black: 2 }, scrap: { red: 0, black: 1 } })).toBe(
      skinsSignature({ scrap: { red: 0, black: 1 }, stub: { red: 1, black: 2 } }),
    );
  });

  it("没有数据 → 空串（与「有数据但全 0」区分开）", () => {
    expect(skinsSignature(undefined)).toBe("");
    expect(skinsSignature({})).not.toBe("");
  });
});

describe("derivedSkin：兜底款必须铺得开且确定", () => {
  it("各款都会出现（不是永远落在同一款上）", () => {
    const seen = new Set(Array.from({ length: 300 }, (_, i) => derivedSkin(`cat:f001#crowd-${i}`)));
    expect([...seen].sort()).toEqual([...STICKER_SKIN_KEYS].sort());
  });

  it("确定性：同一个 id 永远同一款", () => {
    expect(derivedSkin("cat:f001#crowd-7")).toBe(derivedSkin("cat:f001#crowd-7"));
  });
});
