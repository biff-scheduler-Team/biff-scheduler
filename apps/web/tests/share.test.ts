// 分享文案模板单测（2026-09-11 新增；2026-09-15 加 CODE 前置；2026-09-16 改「三行缩进块 + 去 emoji」，
// 见 PLAN-20260916002752；2026-09-22 去掉顺位 / 开票批次两个可选扩展，见 PLAN-20260922102751）。
// 这套格式是「对外承诺」（贴到微信里长什么样），改格式必须同步改这里 —— 否则线上文案会悄悄漂移。
// 覆盖点：① 三行缩进块 + 日期分节 + 概要计数；② CODE 在**行首**、影院行不再重复印；
//        ③ 跨午夜印「次日」不印 24+ 制；④ GV 三态（映后 / 仅正片 / 非 GV）；
//        ⑤ 中文名单独一行且与英文名同判同规则；⑥ 备注行；⑦ 内部排序（乱序输入也按日期 / 时间排）；
//        ⑧ 影院短名；⑨ 空输入；⑩ 通篇不含 emoji；⑪ 通篇不含顺位 / 批次字样（两个扩展已下线）。

import { describe, expect, it } from "vitest";
import type { PickRow } from "../src/ics";
import { buildShareText } from "../src/share";
import type { Mapping } from "../src/types";
import { catalog, show } from "./helpers";

const NO_MAP = new Map<string, Mapping>();

/** 一条已选场次（默认无备注） */
function row(code: string, patch: Partial<PickRow> = {}): PickRow {
  return { code, note: "", ...patch };
}

/** emoji 区段（`↳` 是箭头符号、`①②` 是带圈序号，都不在这个范围内 —— 它们是有意的排版字符） */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

describe("buildShareText:格式", () => {
  it("三行缩进块 + 日期分节 + 概要(共 N 场 / M 部),CODE 在场次行首、续行与片名左对齐", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Alpha" }),
      show({ code: "002", date: "2026-10-09", start_time: "13:00", end_time: "14:40", title_en: "Beta" }),
    ]);
    expect(buildShareText(cat, [row("001"), row("002")], NO_MAP, () => true)).toBe(
      [
        "BIFF 2026 看片计划",
        "OCT 8–OCT 9 · 共 2 场 / 2 部",
        "━━━━━━━━━━━━",
        "",
        "【OCT 8 · 周四】",
        "001  10:00–11:40  Alpha",
        "                  BCC 1",
        "",
        "【OCT 9 · 周五】",
        "002  13:00–14:40  Beta",
        "                  BCC 1",
      ].join("\n")
    );
  });

  it("通篇不含 emoji(旧版的 🎬 / 📅 / 📍 / 📝 全部去掉)", () => {
    const cat = catalog([show({ code: "001", is_gv: true })]);
    const text = buildShareText(cat, [row("001", { note: "带朋友" })], NO_MAP, () => true);
    expect(text).not.toMatch(EMOJI);
    expect(text).toContain("备注 带朋友");
  });

  it("同一天只有一场时概要印单日,不印区间", () => {
    const cat = catalog([show({ code: "001", title_en: "Alpha" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("OCT 8 · 共 1 场 / 1 部");
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

  it("跨午夜场的时间串更长,续行缩进仍与英文名左对齐(不写死空格数)", () => {
    const cat = catalog([show({ code: "001", start_time: "23:59", end_time: "29:35", title_en: "Late" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    // 「23:59–次日 05:35」= 14 字符 ⇒ 续行缩进 = 3 + 2 + 14 + 2 = 21
    expect(text).toContain(["001  23:59–次日 05:35  Late", `${" ".repeat(21)}BCC 1`].join("\n"));
  });

  it("GV 三态:映后 / 仅正片 / 非 GV 不标", () => {
    const cat = catalog([show({ code: "001", is_gv: true })]);
    expect(buildShareText(cat, [row("001")], NO_MAP, () => true)).toContain("· 映后");
    expect(buildShareText(cat, [row("001")], NO_MAP, () => false)).toContain("· 仅正片");

    const plain = catalog([show({ code: "001" })]);
    expect(buildShareText(plain, [row("001")], NO_MAP, () => true)).not.toContain("GV");
  });

  it("影院行只印影院短名(CODE 已前置到场次行首,不重复印)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("001  10:00–11:40  Test Film\n                  BCC 1");
    expect(text).not.toContain("BCC 1 · 001");
    expect(text).not.toContain("必看");
  });

  it("中文名单独一行(与英文名左对齐);英文名相同时不重复印", () => {
    const cat = catalog([show({ code: "001", title_en: "Test Film" })]);
    const map = new Map<string, Mapping>([
      ["001", { code: "001", subject_id: 1, title_cn: "测试片", douban_url: null }],
    ]);
    expect(buildShareText(cat, [row("001")], map, () => true)).toContain(
      ["001  10:00–11:40  Test Film", "                  测试片", "                  BCC 1"].join("\n")
    );
    // 中文名与英文名逐字相同 → 只印一行(与 `util.ts::bilingualRows` 同判同规则)
    const same = new Map<string, Mapping>([
      ["001", { code: "001", subject_id: 1, title_cn: "Test Film", douban_url: null }],
    ]);
    const text = buildShareText(cat, [row("001")], same, () => true);
    expect(text).toContain("001  10:00–11:40  Test Film\n                  BCC 1");
  });

  it("备注缩进到片名列(不再有 📝 前缀)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001", { note: "带朋友" })], NO_MAP, () => true);
    expect(text).toContain("                  BCC 1\n                  备注 带朋友");
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

  it("影院走短名,不落全名(与网格 / .ics 同一口径)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("BCC 1"); // venues.json 的 short,不是全名「BCC Cinema 1」
    expect(text).not.toContain("BCC Cinema 1");
  });

  it("通篇不含顺位 / 批次字样(两个扩展已于 2026-09-22 下线)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    for (const needle of ["主选", "备选", "↳", "批"]) {
      expect(text).not.toContain(needle);
    }
  });
});
