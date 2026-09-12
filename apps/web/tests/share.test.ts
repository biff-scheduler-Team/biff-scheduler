// 分享文案模板(2026-09-11 新增)单测。
// 这套格式是「对外承诺」(贴到微信里长什么样),改格式必须同步改这里 —— 否则线上文案会悄悄漂移。
// 覆盖点:① 两行一场 + 日期分节 + 概要计数;② 跨午夜印「次日」不印 24+ 制;
//        ③ GV 三态;④ 备注行;⑤ 内部排序(乱序输入也按日期 / 时间排);
//        ⑥ 影院短名与「英文名 · 中文名」片名口径;⑦ 空输入。

import { describe, expect, it } from "vitest";
import type { PickRow } from "../src/ics";
import { buildShareText } from "../src/share";
import type { Mapping } from "../src/types";
import { catalog, show } from "./helpers";

const NO_MAP = new Map<string, Mapping>();

/** 一条已选场次(默认无备注) */
function row(code: string, patch: Partial<PickRow> = {}): PickRow {
  return { code, note: "", ...patch };
}

describe("buildShareText:格式", () => {
  it("两行一场 + 日期分节 + 概要(共 N 场 / M 部)", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Alpha" }),
      show({ code: "002", date: "2026-10-09", start_time: "13:00", end_time: "14:40", title_en: "Beta" }),
    ]);
    expect(buildShareText(cat, [row("001"), row("002")], NO_MAP, () => true)).toBe(
      [
        "🎬 BIFF 2026 看片计划",
        "📅 OCT 8–OCT 9 · 共 2 场 / 2 部",
        "━━━━━━━━━━━━",
        "",
        "【OCT 8 周四 · 1 场】",
        "10:00–11:40  Alpha",
        "📍 BCC 1 · 001",
        "",
        "【OCT 9 周五 · 1 场】",
        "13:00–14:40  Beta",
        "📍 BCC 1 · 002",
      ].join("\n")
    );
  });

  it("同一天只有一场时概要印单日,不印区间", () => {
    const cat = catalog([show({ code: "001", title_en: "Alpha" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("📅 OCT 8 · 共 1 场 / 1 部");
  });

  it("同一部片的两场只计 1 部", () => {
    const cat = catalog([show({ code: "001" }), show({ code: "002", start_time: "13:00" })]);
    const text = buildShareText(cat, [row("001"), row("002")], NO_MAP, () => true);
    expect(text).toContain("共 2 场 / 1 部");
  });

  it("空输入返回空串(调用方据此提示「还没有选片」,不复制空文本)", () => {
    expect(buildShareText(catalog([]), [], NO_MAP, () => true)).toBe("");
  });
});

describe("buildShareText:场次口径", () => {
  it("跨午夜场印「次日 HH:MM」,绝不出现 24+ 制", () => {
    const cat = catalog([show({ code: "001", start_time: "23:59", end_time: "29:35" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("23:59–次日 05:35");
    expect(text).not.toContain("29:35");
  });

  it("GV 三态:含映后谈 / 仅正片 / 非 GV 不标", () => {
    const cat = catalog([show({ code: "001", is_gv: true })]);
    expect(buildShareText(cat, [row("001")], NO_MAP, () => true)).toContain("· GV 含映后谈");
    expect(buildShareText(cat, [row("001")], NO_MAP, () => false)).toContain("· GV 仅正片");

    const plain = catalog([show({ code: "001" })]);
    expect(buildShareText(plain, [row("001")], NO_MAP, () => true)).not.toContain("GV");
  });

  it("影院行只印「短名 · CODE」(档位已删除,不再有第三段)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("📍 BCC 1 · 001");
    expect(text).not.toContain("必看");
  });

  it("备注另起一行(📝 前缀)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001", { note: "带朋友" })], NO_MAP, () => true);
    expect(text).toContain("📍 BCC 1 · 001");
    expect(text).toContain("📝 带朋友");
  });

  it("乱序输入在函数内按「日期 → 开场时间」重排(分节头依赖有序)", () => {
    const cat = catalog([
      show({ code: "001", start_time: "18:00", end_time: "19:40" }),
      show({ code: "002", start_time: "09:00", end_time: "10:40" }),
      show({ code: "003", date: "2026-10-07", start_time: "20:00", end_time: "21:40" }),
    ]);
    const text = buildShareText(cat, [row("001"), row("002"), row("003")], NO_MAP, () => true);
    expect(text.indexOf("【OCT 7")).toBeLessThan(text.indexOf("【OCT 8"));
    expect(text.indexOf("09:00")).toBeLessThan(text.indexOf("18:00"));
  });

  it("影院走短名、片名走「英文名 · 中文名」(与网格 / .ics 同一口径)", () => {
    const cat = catalog([show({ code: "001" })]);
    const map = new Map<string, Mapping>([
      ["001", { code: "001", subject_id: 1, title_cn: "测试片", douban_url: null }],
    ]);
    const text = buildShareText(cat, [row("001")], map, () => true);
    expect(text).toContain("Test Film · 测试片");
    expect(text).toContain("📍 BCC 1 ·"); // venues.json 的 short,不是全名「BCC Cinema 1」
  });
});
