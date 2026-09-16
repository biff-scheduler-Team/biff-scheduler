// 「吃喝」页的纯逻辑(2026-09-16,`PLAN-20260916232230` 修订 1)。
// 覆盖:检索串的取名优先级、三条地图链接的模板、用户提交列表的读写与上限、静态清单的降级。
// ⚠ 不测组件渲染 —— 那是 `e2e/react/eats.spec.ts` 的事。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubmission,
  districtLabel,
  EATS_KEY,
  eatLinkLabel,
  eatLinks,
  eatName,
  eatQuery,
  eatSubName,
  loadEatsFile,
  MAX_SUBMISSIONS,
  readSubmissions,
  removeSubmission,
  type EatShop,
} from "../src/eats";

const shop: EatShop = {
  id: "halmae-gukbab",
  name_kr: "60년전통할매국밥",
  name_en: "Halmae Gukbab",
  name_zh: "60年传统奶奶汤饭",
  hours: "10:00-19:00（周日休息）",
  menu: "猪肉汤饭",
  price: "30",
  address_kr: "부산 동구 중앙대로533번길 4",
  address_en: "4, Jungang-daero 533beon-gil, Dong-gu",
  note: "",
  link: "",
  district: "donggu",
};

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("店铺取名", () => {
  it("主名给中文、副名给韩文 —— 到了现场给店家看韩文名最有用", () => {
    expect(eatName(shop)).toBe("60年传统奶奶汤饭");
    expect(eatSubName(shop)).toBe("60년전통할매국밥");
  });

  it("没有中文名时主名退回韩文,且副名不再重复主名", () => {
    expect(eatName({ ...shop, name_zh: "" })).toBe("60년전통할매국밥");
    expect(eatSubName({ ...shop, name_zh: "" })).toBe("Halmae Gukbab");
  });
});

describe("检索串", () => {
  it("优先用韩文名 + 韩文地址 —— 中文名在韩国地图上基本搜不到", () => {
    expect(eatQuery(shop)).toBe("60년전통할매국밥 부산 동구 중앙대로533번길 4");
  });

  it("只有中文名时退回中文名,但仍带上地址帮地图消歧", () => {
    expect(eatQuery({ ...shop, name_kr: "", address_kr: "" })).toBe(
      "60年传统奶奶汤饭 4, Jungang-daero 533beon-gil, Dong-gu",
    );
  });

  it("地址全缺时只留名字,不留尾随空格", () => {
    expect(eatQuery({ ...shop, address_kr: "", address_en: "" })).toBe("60년전통할매국밥");
  });
});

describe("三条地图链接", () => {
  it("模板与 legend.ts 一致,且中文/空格/斜杠都被转义", () => {
    const links = eatLinks("부산 중구 중앙대로 4");
    expect(links.google).toBe(
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("부산 중구 중앙대로 4"),
    );
    expect(links.naver).toBe(
      "https://map.naver.com/p/search/" + encodeURIComponent("부산 중구 중앙대로 4"),
    );
    expect(links.kakao).toBe(
      "https://map.kakao.com/link/search/" + encodeURIComponent("부산 중구 중앙대로 4"),
    );
  });
});

describe("人工整理链接的标签", () => {
  it("按域名给人话标签,不印光秃秃的 URL", () => {
    expect(eatLinkLabel("https://www.xiaohongshu.com/discovery/item/6579")).toBe("小红书");
    expect(eatLinkLabel("https://naver.me/xQ8YsvDSh")).toBe("Naver 店铺");
    expect(eatLinkLabel("https://map.naver.com/p/entry/place/1")).toBe("Naver 店铺");
    expect(eatLinkLabel("https://www.instagram.com/horang2__gelatteok/")).toBe("Instagram");
  });

  it("认识的域用域名兜底(不假装认识),非法 URL 与空串都不炸", () => {
    expect(eatLinkLabel("https://example.com/a/b")).toBe("example.com");
    expect(eatLinkLabel("not a url")).toBe("原始链接");
    expect(eatLinkLabel("")).toBe("");
  });
});

describe("分区标签", () => {
  it("已知分区给中文名,未知分区一律落到「其他」", () => {
    expect(districtLabel("haeundae")).toBe("海云台");
    expect(districtLabel("donggu")).toBe("东区");
    expect(districtLabel("nowhere")).toBe("其他");
  });
});

describe("用户提交的店铺", () => {
  it("新提交排在最前,并且能被读回来", () => {
    addSubmission({ name: "五福猪肉汤饭", district: "haeundae", address: "", note: "" });
    addSubmission({ name: "雪绿茶", district: "haeundae", address: "구남로 36-1", note: "抹茶" });
    const list = readSubmissions();
    expect(list.map((item) => item.name)).toEqual(["雪绿茶", "五福猪肉汤饭"]);
    expect(list[0].address).toBe("구남로 36-1");
  });

  it("id 带 user: 前缀 —— 与静态清单的 slug 不会撞", () => {
    addSubmission({ name: "古来思", district: "haeundae", address: "", note: "" });
    expect(readSubmissions()[0].id.startsWith("user:")).toBe(true);
  });

  it("按 id 删除只删那一条", () => {
    addSubmission({ name: "A", district: "other", address: "", note: "" });
    addSubmission({ name: "B", district: "other", address: "", note: "" });
    const target = readSubmissions().find((item) => item.name === "A")!;
    expect(removeSubmission(target.id).map((item) => item.name)).toEqual(["B"]);
  });

  it("超出上限时截断 —— 本地键与云端同步值都是整键字符串,不能无限膨胀", () => {
    for (let i = 0; i < MAX_SUBMISSIONS + 5; i++)
      addSubmission({ name: `店 ${i}`, district: "other", address: "", note: "" });
    expect(readSubmissions()).toHaveLength(MAX_SUBMISSIONS);
  });

  it("值损坏 / 不是数组 / 元素缺 id 时都当空表或过滤掉,不抛异常", () => {
    localStorage.setItem(EATS_KEY, "{ not json");
    expect(readSubmissions()).toEqual([]);
    localStorage.setItem(EATS_KEY, JSON.stringify({ a: 1 }));
    expect(readSubmissions()).toEqual([]);
    localStorage.setItem(EATS_KEY, JSON.stringify([{ name: "没有 id" }, { id: "user:1", name: "有 id" }]));
    expect(readSubmissions().map((item) => item.name)).toEqual(["有 id"]);
  });
});

describe("静态清单加载", () => {
  it("文件缺失 / 服务端报错时返回 null(页面走空态,而不是崩掉)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await loadEatsFile()).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await loadEatsFile()).toBeNull();
  });

  it("shops 不是数组时也当 null —— 结构守卫与 data.ts 同口径", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ shops: null }) }));
    expect(await loadEatsFile()).toBeNull();
  });

  it("正常文件原样返回", async () => {
    const file = { generated_at: "2026-09-16", source: "表格", notice: "", shops: [shop] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => file }));
    expect((await loadEatsFile())?.shops).toHaveLength(1);
  });
});
