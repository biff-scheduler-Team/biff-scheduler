// 官网辅助信息(售票 / 节目 / 票价)的纯函数口径 —— 开票时间解析与票价推断最容易静默出错:
// 前者跨时区(官网印 KST,前端要同时给北京时间),后者是「一场要花多少」的唯一来源。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countdownText, formatKrw, loadExtras, nextTicketOpen, priceOf, ticketOpens } from "../src/extras";
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

describe("开票时间:官网 KST 文本 → 绝对时刻 + 双时区显示", () => {
  it("Sep 17(Thu) 14:00 (KST) → UTC 05:00;韩 14:00 / 京 13:00", () => {
    const opens = ticketOpens(2026);
    expect(opens).toHaveLength(2);
    expect(opens[0].at).toBe(Date.UTC(2026, 8, 17, 5, 0));
    expect(opens[0].kst).toBe("9/17 14:00");
    expect(opens[0].bj).toBe("9/17 13:00"); // 北京时间 = KST − 1h
  });

  it("批次按时间升序;解析不出来的批次被丢弃(不产出错时间)", () => {
    const opens = ticketOpens(2026);
    expect(opens[0].at).toBeLessThan(opens[1].at);
    expect(opens[1].bj).toBe("9/21 13:00");
  });

  it("nextTicketOpen:未到 → 该批;全部已过 → null", () => {
    const before = Date.UTC(2026, 8, 1);
    const mid = Date.UTC(2026, 8, 18);
    const after = Date.UTC(2026, 9, 1);
    expect(nextTicketOpen(2026, before)?.kst).toBe("9/17 14:00");
    expect(nextTicketOpen(2026, mid)?.kst).toBe("9/21 14:00");
    expect(nextTicketOpen(2026, after)).toBeNull();
  });

  it("countdownText 逐级细化:天 → 小时 → 分秒", () => {
    expect(countdownText((6 * 86400 + 3 * 3600) * 1000)).toBe("6 天 3 小时");
    expect(countdownText((3 * 3600 + 12 * 60) * 1000)).toBe("3 小时 12 分");
    expect(countdownText((12 * 60 + 5) * 1000)).toBe("12 分 05 秒");
    expect(countdownText(-1000)).toBe("0 秒"); // 负数不产出「-1 秒」
  });
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
