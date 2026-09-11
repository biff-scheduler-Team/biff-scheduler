// .ics 导出与转场余量的口径单测(2026-09-11 补:这两块此前零覆盖)。
// 覆盖点:① RFC5545 转义(逗号 / 分号);② 行按 UTF-8 字节折叠(中文);
//        ③ 跨午夜 DTEND 进位(不取模);④ `slackBetween` 三态与跨馆缓冲。

import { describe, expect, it } from "vitest";
import { buildIcs, type PickRow } from "../src/ics";
import { minToHms, slackBetween } from "../src/util";
import { catalog, show } from "./helpers";

const ENTRIES: PickRow[] = [{ code: "001", group: "A", priority: "must", note: "" }];
const NO_MAP = new Map();

describe("ics:转义与折叠", () => {
  it("LOCATION 里的逗号 / 分号按 RFC5545 转义(否则日历解析器会拆错字段)", () => {
    const cat = catalog([show({ code: "001", venue_display: "BCC, Cinema 1; Hall" })]);
    const ics = buildIcs(cat, ENTRIES, NO_MAP, 45, () => true);
    expect(ics).toContain("LOCATION:BCC\\, Cinema 1\\; Hall");
  });

  it("DESCRIPTION 的多行用字面 \\n 表示,不产生真实换行", () => {
    const cat = catalog([show({ code: "001" })]);
    const ics = buildIcs(cat, ENTRIES, NO_MAP, 45, () => true);
    expect(ics).toMatch(/DESCRIPTION:[^\r\n]*\\n/);
  });

  it("每一行的 UTF-8 字节数 ≤ 75(中文按字节折叠,不是按字符)", () => {
    const longZh = "电".repeat(80);
    const cat = catalog([show({ code: "001", title_zh: longZh, title_en: longZh })]);
    const ics = buildIcs(cat, ENTRIES, NO_MAP, 45, () => true);
    const enc = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("跨午夜场:DTEND 进位到次日,晚于 DTSTART", () => {
    const cat = catalog([show({ code: "001", start_time: "23:59", end_time: "29:35" })]);
    const ics = buildIcs(cat, ENTRIES, NO_MAP, 45, () => true);
    const start = /DTSTART:(\S+)/.exec(ics)?.[1] ?? "";
    const end = /DTEND:(\S+)/.exec(ics)?.[1] ?? "";
    expect(start).toBe("20261008T145900Z"); // 23:59 KST = 14:59Z
    expect(end > start).toBe(true); // 旧版 `%24` 取模会把 DTEND 折到 DTSTART 之前
  });
});

describe("slackBetween:转场余量三态", () => {
  it("同馆不扣缓冲,余量 = 间隔", () => {
    expect(slackBetween(100, 120, true, 30).slack).toBe(20);
  });

  it("跨馆扣缓冲", () => {
    expect(slackBetween(100, 120, false, 30).slack).toBe(-10);
  });

  it("三态:bad(<0)/ tight(<okSlack)/ ok", () => {
    expect(slackBetween(100, 99, true, 0).verdict).toBe("bad");
    expect(slackBetween(100, 110, true, 0).verdict).toBe("tight");
    expect(slackBetween(100, 130, true, 0).verdict).toBe("ok");
  });

  it("阈值可注入(质量分与网格共用同一函数)", () => {
    expect(slackBetween(100, 110, true, 0, 5).verdict).toBe("ok");
  });
});

describe("minToHms:小数分钟不产出非法时刻", () => {
  it("1439.6 先整体取整 → 24:00(旧实现会得到 23:60)", () => {
    expect(minToHms(1439.6)).toBe("24:00");
  });

  it("整数输入保持原样", () => {
    expect(minToHms(1775)).toBe("29:35");
    expect(minToHms(0)).toBe("00:00");
  });
});
