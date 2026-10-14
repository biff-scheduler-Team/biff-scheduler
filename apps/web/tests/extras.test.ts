// 官网辅助信息(票价)的纯函数口径 —— 票价推断最容易静默出错:
// 它是「一场要花多少」的唯一来源。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatKrw, loadExtras, priceOf } from "../src/extras";
import { show } from "./helpers";

const EXTRAS = {
  source: "https://www.biff.kr/eng/",
  generated_at: "2026-09-11T00:00:00+09:00",
  ticketing: {
    batches: [
      { includes: "Opening & Closing Ceremony / Midnight Passion", openText: "Sep 17(Thu) 14:00 (KST)" },
      { includes: "General Screenings / Master Class", openText: "Sep 21(Mon) 14:00 (KST)" },
    ],
    prices: [{ label: "General Screenings", krw: 10000 }],
    discountKrw: 3000,
    notes: [],
    callCenter: "1666-9177",
    url: "https://www.biff.kr/eng/",
  },
  programs: [
    {
      code: "811",
      kind: "master_class",
      title: "Master Class : NA Hong-jin",
      guest: "NA Hong-jin",
      guestZh: "罗泓轸",
      dateText: "Oct 8 (Thu) 11:00 - 12:30",
      priceKrw: 15000,
      language: "English, Korean",
      venue: "Culture Hall (9F)",
      moderator: "",
      bio: "",
    },
  ],
  ceremony: { openingDate: "Oct 6(Tue)", closingDate: "Oct 15(Thu)", slots: [], traffic: [], url: "" },
};

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => EXTRAS })));
  await loadExtras();
});

describe("票价:节目页优先,其次按场次类型推断", () => {
  it("活动节目命中官网票价", () => {
    expect(priceOf(show({ code: "811" }))).toBe(15000);
  });

  it("开闭幕 / 午夜 / 大师班 / 普通 各走各档", () => {
    expect(priceOf(show({ code: "001", tags: ["opening"] }))).toBe(30000);
    expect(priceOf(show({ code: "002", tags: ["closing"] }))).toBe(30000);
    expect(priceOf(show({ code: "075", title_en: "Midnight Passion 1" }))).toBe(20000);
    expect(priceOf(show({ code: "811b", tags: ["masterclass"] }))).toBe(15000);
    expect(priceOf(show({ code: "801b", title_en: "Actors’ House: LEE Minho", tags: ["event"] }))).toBe(15000);
    expect(priceOf(show({ code: "999", title_en: "Some Normal Film" }))).toBe(10000);
  });

  it("formatKrw 用 ₩ 且带千分位(避免与人民币 ¥ 混淆)", () => {
    expect(formatKrw(30000)).toBe("₩30,000");
    expect(formatKrw(10000)).toBe("₩10,000");
  });
});
