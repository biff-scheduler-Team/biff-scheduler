import { describe, expect, it } from "vitest";
import {
  TICKET_IMPORT_APP,
  looksLikeTicketImport,
  parseTicketImport,
} from "../src/ticket-import";

// 票务 JSON 导入(2026-09-24,`PLAN-20260924141442` 修订 5)。纯逻辑,不碰 DOM / localStorage。
// ★ 本文件守的两条口径:
//   ① **`seats` 的四种写法都认**(数组 / 数字 / 单串 / 省略),且数字与界面同一个张数上限;
//   ② **同一个 code 出现两次直接报错**,不静默取后者 —— 「导入成功但少了一半票」那种错很难被发现。

describe("parseTicketImport:认哪些形状", () => {
  it("★ 信封 { tickets: [...] } 与裸数组都认(只复制了 tickets 段的场景)", () => {
    const rows = [
      { code: "001", seats: ["Sec 7 · R2 S4"], name: "RAOJIARUI", bookingNo: "269KETJ", account: "foxmail" },
    ];
    const envelope = parseTicketImport(
      JSON.stringify({ app: TICKET_IMPORT_APP, version: 1, tickets: rows }),
    );
    const bare = parseTicketImport(JSON.stringify(rows));
    for (const result of [envelope, bare]) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows).toEqual(rows);
      expect(result.seatTotal).toBe(1);
    }
  });

  it("★ seats 的四种写法:数组 / 数字(= N 张不划位)/ 单个字符串 / 省略(= 1 张)", () => {
    const result = parseTicketImport(
      JSON.stringify([
        { code: "001", seats: ["Sec 7 · R2 S4"] },
        { code: "003", seats: 2 },
        { code: "004", seats: "R G S8" },
        { code: "053" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.seats)).toEqual([
      ["Sec 7 · R2 S4"],
      ["", ""],
      ["R G S8"],
      [""],
    ]);
    expect(result.seatTotal).toBe(5);
  });

  it("数字张数按界面同一上限封顶,且非正整数直接报错", () => {
    const capped = parseTicketImport(JSON.stringify([{ code: "001", seats: 999 }]));
    expect(capped.ok).toBe(true);
    if (capped.ok) expect(capped.rows[0].seats).toHaveLength(10);

    for (const seats of [0, -1, 1.5]) {
      const bad = parseTicketImport(JSON.stringify([{ code: "001", seats }]));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain("seats");
    }
  });

  it("持票信息照收;非字符串的座位项按空座处理(不静默丢位置)", () => {
    const result = parseTicketImport(
      JSON.stringify([
        { code: "180", seats: ["R A S17", null, 3], name: "RAOJIARUI", bookingNo: "269LE2W4", account: "foxmail" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      code: "180",
      seats: ["R A S17", "", ""],
      name: "RAOJIARUI",
      bookingNo: "269LE2W4",
      account: "foxmail",
    });
  });
});

describe("parseTicketImport:拒收与原因", () => {
  it("★ 同一个 code 出现两次 → 直接报错(不静默取后者)", () => {
    const result = parseTicketImport(
      JSON.stringify([
        { code: "001", seats: ["A"] },
        { code: "001", seats: ["B"] },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("001");
  });

  it("场次编号形状不对 → 报错并指出是第几条", () => {
    for (const code of ["1", "0001", "abc", "", 8]) {
      const result = parseTicketImport(JSON.stringify([{ code, seats: ["A"] }]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("第 1 条");
    }
  });

  it("P&I 场次的内部编号也认(PI-09-01)", () => {
    const result = parseTicketImport(JSON.stringify([{ code: "PI-09-01", seats: ["A"] }]));
    expect(result.ok).toBe(true);
  });

  it("空内容 / 非法 JSON / 非对象 / 没有 tickets 数组 → 逐条给得出原因", () => {
    expect(parseTicketImport("   ").ok).toBe(false);
    const notJson = parseTicketImport("nope");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error).toContain("JSON");

    const scalar = parseTicketImport("42");
    expect(scalar.ok).toBe(false);

    const noTickets = parseTicketImport(JSON.stringify({ hello: "world" }));
    expect(noTickets.ok).toBe(false);
    if (!noTickets.ok) expect(noTickets.error).toContain("tickets");

    const empty = parseTicketImport("[]");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("没有任何票务记录");
  });

  it("数组项不是对象 → 报错", () => {
    const result = parseTicketImport(JSON.stringify([["001"]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 1 条");
  });
});

describe("looksLikeTicketImport:分流判据", () => {
  it("★ 认得出票务 JSON(信封 / 裸数组两种)", () => {
    expect(looksLikeTicketImport(JSON.stringify({ tickets: [] }))).toBe(true);
    expect(looksLikeTicketImport(JSON.stringify([{ code: "001" }]))).toBe(true);
    expect(looksLikeTicketImport(JSON.stringify({ app: TICKET_IMPORT_APP }))).toBe(true);
  });

  it("★ 备份信封与 .ics 不被误判(它们是另一条通道的活)", () => {
    expect(looksLikeTicketImport(JSON.stringify({ app: "biff-scheduler", data: { "biff.picks.v2": "[]" } }))).toBe(false);
    expect(looksLikeTicketImport(JSON.stringify({ "biff.picks.v2": "[]" }))).toBe(false);
    expect(looksLikeTicketImport("BEGIN:VCALENDAR")).toBe(false);
    expect(looksLikeTicketImport(JSON.stringify([1, 2, 3]))).toBe(false);
  });

  it("★ 解析不了的文本**不当**票务 —— 交给备份通道报既有的那句「不是有效的 JSON」", () => {
    expect(looksLikeTicketImport("invalid JSON")).toBe(false);
    expect(looksLikeTicketImport("")).toBe(false);
  });
});
