// 分享文案模板单测（2026-09-11 新增；2026-09-15 加 CODE 前置与可选顺位 / 备选 / 开票批次）。
// 这套格式是「对外承诺」（贴到微信里长什么样），改格式必须同步改这里 —— 否则线上文案会悄悄漂移。
// 覆盖点：① 两行一场 + 日期分节 + 概要计数；② CODE 在**行首**、影院行不再重复印；
//        ③ 跨午夜印「次日」不印 24+ 制；④ GV 三态；⑤ 备注行；
//        ⑥ 内部排序（乱序输入也按日期 / 时间排）；⑦ 影院短名与「英文名 · 中文名」片名口径；
//        ⑧ 空输入；⑨ 带顺位时的顺位 + 备选行；⑩ 带批次时的批次分节。

import { describe, expect, it } from "vitest";
import { ticketBatchOf } from "../src/batch";
import type { PickRow } from "../src/ics";
import { buildShareText, type ShareOptions } from "../src/share";
import type { Mapping } from "../src/types";
import { catalog, show } from "./helpers";

const NO_MAP = new Map<string, Mapping>();

/** 一条已选场次（默认无备注） */
function row(code: string, patch: Partial<PickRow> = {}): PickRow {
  return { code, note: "", ...patch };
}

/** 顺位夹具：rank 表 + 组内其余场次（与行程页口径一致：同组才顺位） */
function ranking(ranks: Record<string, number>, groups: string[][]): ShareOptions["ranking"] {
  const mates = new Map<string, string[]>();
  for (const group of groups) {
    for (const code of group) mates.set(code, group.filter((c) => c !== code));
  }
  return { rankOf: new Map(Object.entries(ranks)), matesOf: (code) => mates.get(code) ?? [] };
}

describe("buildShareText:格式", () => {
  it("两行一场 + 日期分节 + 概要(共 N 场 / M 部),CODE 在场次行首", () => {
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
        "001  10:00–11:40  Alpha",
        "📍 BCC 1",
        "",
        "【OCT 9 周五 · 1 场】",
        "002  13:00–14:40  Beta",
        "📍 BCC 1",
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
    expect(buildShareText(cat, [row("001")], NO_MAP, () => true)).toContain("· 含映后谈");
    expect(buildShareText(cat, [row("001")], NO_MAP, () => false)).toContain("· 仅正片");

    const plain = catalog([show({ code: "001" })]);
    expect(buildShareText(plain, [row("001")], NO_MAP, () => true)).not.toContain("GV");
  });

  it("影院行只印影院短名(CODE 已前置到场次行首,不重复印)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).toContain("001  10:00–11:40  Test Film\n📍 BCC 1");
    expect(text).not.toContain("📍 BCC 1 · 001");
    expect(text).not.toContain("必看");
  });

  it("备注另起一行(📝 前缀)", () => {
    const cat = catalog([show({ code: "001" })]);
    const text = buildShareText(cat, [row("001", { note: "带朋友" })], NO_MAP, () => true);
    expect(text).toContain("📍 BCC 1");
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
    expect(text).toContain("📍 BCC 1"); // venues.json 的 short,不是全名「BCC Cinema 1」
  });
});

describe("buildShareText:顺位与备选(抢票分工)", () => {
  const cat = catalog([
    show({ code: "001", title_en: "Alpha" }),
    show({ code: "002", title_en: "Beta", start_time: "13:00", end_time: "14:40" }),
    show({ code: "003", title_en: "Gamma", date: "2026-10-09" }),
  ]);

  it("勾选后:场次行尾印组内顺位,同组备选另起一行(含 CODE / 时间 / 片名 / 影院 / 顺位)", () => {
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true, {
      ranking: ranking({ "001": 1, "002": 2 }, [["001", "002"]]),
    });
    expect(text).toContain(
      [
        "001  10:00–11:40  Alpha",
        "📍 BCC 1 · 顺位 1",
        "   ↳ 备选 002  13:00–14:40  Beta  BCC 1 · 顺位 2",
      ].join("\n")
    );
  });

  it("备选行不印日期(冲突按日期隔离 ⇒ 同组必然同日)", () => {
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true, {
      ranking: ranking({ "001": 1, "002": 2 }, [["001", "002"]]),
    });
    const alt = text.split("\n").find((line) => line.includes("↳ 备选"))!;
    expect(alt).not.toContain("OCT");
  });

  it("不带顺位时完全没有「顺位」「备选」字样(基线版式)", () => {
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true);
    expect(text).not.toContain("顺位");
    expect(text).not.toContain("备选");
  });

  it("不在冲突组里的共同场次没有顺位可印(不兜底成「顺位 1」)", () => {
    const text = buildShareText(cat, [row("003")], NO_MAP, () => true, {
      ranking: ranking({ "001": 1, "002": 2 }, [["001", "002"]]),
    });
    expect(text).toContain("📍 BCC 1");
    expect(text).not.toContain("顺位");
  });

  it("备选在排期里已不存在 → 静默跳过,不留空行", () => {
    const text = buildShareText(cat, [row("001")], NO_MAP, () => true, {
      ranking: { rankOf: new Map([["001", 1]]), matesOf: () => ["999"] },
    });
    expect(text).toContain("📍 BCC 1 · 顺位 1");
    expect(text).not.toContain("↳");
  });
});

describe("buildShareText:开票批次分节", () => {
  const cat = catalog([
    show({
      code: "003",
      title_en: "Look Back",
      date: "2026-10-07",
      start_time: "20:00",
      end_time: "21:40",
      venue_id: "bt",
      venue_display: "BCC Roof",
    }),
    show({ code: "004", title_en: "Alpha" }),
  ]);
  const batching: ShareOptions["batching"] = {
    batchOf: (s) => ticketBatchOf(s),
    headOf: (batch) => `第 ${batch} 批 · ${batch === 1 ? "9/17" : "9/21"} 14:00 KST / 北京 13:00`,
  };

  it("按批次分节,节内再按日期分节(露天场落第 1 批)", () => {
    expect(buildShareText(cat, [row("003"), row("004")], NO_MAP, () => true, { batching })).toBe(
      [
        "🎬 BIFF 2026 看片计划",
        "📅 OCT 7–OCT 8 · 共 2 场 / 2 部",
        "━━━━━━━━━━━━",
        "",
        "【第 1 批 · 9/17 14:00 KST / 北京 13:00】",
        "",
        "【OCT 7 周三 · 1 场】",
        "003  20:00–21:40  Look Back",
        "📍 BCC Roof",
        "",
        "【第 2 批 · 9/21 14:00 KST / 北京 13:00】",
        "",
        "【OCT 8 周四 · 1 场】",
        "004  10:00–11:40  Alpha",
        "📍 BCC 1",
      ].join("\n")
    );
  });

  it("只有一批时另一批不出现", () => {
    const text = buildShareText(cat, [row("004")], NO_MAP, () => true, { batching });
    expect(text).toContain("【第 2 批");
    expect(text).not.toContain("【第 1 批");
  });

  it("不勾选批次时输出里没有批次节头(与基线一致)", () => {
    const text = buildShareText(cat, [row("003"), row("004")], NO_MAP, () => true);
    expect(text).not.toContain("批");
  });
});
