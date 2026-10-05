// 「吃喝」清单的数据哨兵(2026-10-05,`PLAN-20261005201040`)。
//
// 为什么单测它:清单是**两源合并**的产物(腾讯文档《BIFF吃喝》+ Naver 共享收藏夹),
// 而合并只发生在 `tools/build_eats.py` 里。谁忘了带第二个参数重跑一次管线,
// 症状不是报错,而是「Naver 那 49 家无声消失」—— typecheck / lint / 页面渲染全都照常绿。
// 这与 `catalogue-data.test.ts` 要防的是同一类静默失效。
//
// ⚠ 只读产物,不碰 DOM(单测跑在 node 环境)。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface EatsShop {
  id: string;
  name_kr: string;
  name_en: string;
  name_zh: string;
  hours: string;
  menu: string;
  price: string;
  address_kr: string;
  address_en: string;
  note: string;
  link: string;
  district: string;
}

interface EatsFile {
  source: string;
  shops: EatsShop[];
}

interface NaverSnapshot {
  source_url: string;
  folder_name: string;
  items: {
    sid: string;
    name_kr: string;
    name_en: string;
    category: string;
    address_kr: string;
    place_url: string;
  }[];
}

const file = JSON.parse(readFileSync("public/eats.json", "utf8")) as EatsFile;
const naver = JSON.parse(readFileSync("../../data/naver-eats-2026.json", "utf8")) as NaverSnapshot;

/** 用精确店铺页当键 —— 它由 sid 生成,比店名可靠(店名可能两源撞名)。
 *  ⚠ 只收非空链接:大半店铺本来就没有来源链接,带空串建表会让它们全部塌成同一个 key。 */
const byLink = new Map(file.shops.filter((shop) => shop.link).map((shop) => [shop.link, shop]));

describe("Naver 共享收藏夹并进「吃喝」清单", () => {
  it("收藏夹里每一家都能在清单里找到 —— 管线漏带第二个参数时这条会红", () => {
    expect(naver.items.length).toBeGreaterThan(0);
    const missing = naver.items.filter((item) => !byLink.has(item.place_url)).map((item) => item.name_kr);
    expect(missing).toEqual([]);
  });

  it("并进来的是同一家店:韩文名与品类都对得上,分区按既有判据推出来", () => {
    for (const item of naver.items) {
      const shop = byLink.get(item.place_url);
      expect(shop).toBeDefined();
      expect(shop?.name_kr).toBe(item.name_kr);
      expect(shop?.menu).toBe(item.category);
      expect(shop?.address_kr).toBe(item.address_kr);
      expect(shop?.district).not.toBe("");
    }
  });

  it("源里没有的字段一律留空,不编 —— 中文名 / 营业时间 / 人均 / 英文地址源里都没有", () => {
    for (const item of naver.items) {
      const shop = byLink.get(item.place_url);
      expect(shop?.name_zh).toBe("");
      expect(shop?.hours).toBe("");
      expect(shop?.price).toBe("");
      expect(shop?.address_en).toBe("");
    }
  });
});

describe("合并后的整体约束", () => {
  it("id 全局唯一 —— 两源共用一张 slug 表,撞名会渲染出两张 key 相同的卡片", () => {
    const ids = file.shops.map((shop) => shop.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("`source` 点出两个数据源 —— 只写表格那一条会让人以为 Naver 这批是手工塞进产物的", () => {
    expect(file.source).toContain("BIFF吃喝");
    expect(file.source).toContain(naver.folder_name);
    expect(file.source).toContain(naver.source_url);
  });
});
