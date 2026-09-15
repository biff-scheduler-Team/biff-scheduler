// 分享图片(行程图)模型单测(2026-09-11 新增;2026-09-16 加顺位 / 备选 / 开票批次)。
// 只测 `poster.ts::buildPosterModel` / `posterHeight` —— **绘制层不测**(canvas 在 node 里没有);
// 画布上的文字由 E2E 的 `__paintedTexts` 钩子断言(`e2e/react/parity-dialogs.spec.ts` 同款)。
// 覆盖点:① 日期分节 + 概要计数;② 内部排序(乱序输入也按日期 / 时间排);
//        ③ 跨午夜印「次日」不印 24+ 制;④ GV 三态;⑤ 备注行与行高;
//        ⑥ 影院短名与「英文名 · 中文名」片名口径;⑦ 空输入 / 已下架场次;
//        ⑧ 带顺位的 rank / 备选行;⑨ 带开票批次的分节与节头(与分享文案同一份 `ShareOptions`)。

import { describe, expect, it } from "vitest";
import { ticketBatchOf } from "../src/batch";
import type { PickRow } from "../src/ics";
import { buildPosterModel, posterHeight } from "../src/poster";
import { type ShareOptions } from "../src/share";
import type { Mapping } from "../src/types";
import { catalog, show } from "./helpers";

const NO_MAP = new Map<string, Mapping>();

/** 一条已选场次(默认无备注) */
function row(code: string, patch: Partial<PickRow> = {}): PickRow {
  return { code, note: "", ...patch };
}

/** 顺位夹具(与 `share.test.ts` 同款):rank 表 + 组内其余场次 —— 口径与行程页一致(只有冲突组才有顺位) */
function ranking(ranks: Record<string, number>, groups: string[][]): ShareOptions["ranking"] {
  const mates = new Map<string, string[]>();
  for (const group of groups) {
    for (const code of group) mates.set(code, group.filter((c) => c !== code));
  }
  return { rankOf: new Map(Object.entries(ranks)), matesOf: (code) => mates.get(code) ?? [] };
}

describe("buildPosterModel:结构与概要", () => {
  it("按日期分节,每节带场次计数;概要给场次 / 影片数与日期区间", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Alpha" }),
      show({ code: "002", title_en: "Beta", start_time: "13:00", end_time: "14:40" }),
      show({ code: "003", title_en: "Gamma", date: "2026-10-09" }),
    ]);
    const model = buildPosterModel(cat, [row("001"), row("002"), row("003")], NO_MAP, () => true);
    expect(model).not.toBeNull();
    // 大标题只放「年份 + 看片计划」—— 节展全名交给上方小字行(否则 52px 排不下,出图被切)
    expect(model!.title).toBe("2026 看片计划");
    expect(model!.festName).toBe("BIFF");
    expect(model!.range).toBe("OCT 8–OCT 9");
    expect(model!.count).toBe(3);
    expect(model!.films).toBe(3);
    expect(model!.days.map((d) => [d.label, d.weekday, d.count])).toEqual([
      ["OCT 8", "周四", 2],
      ["OCT 9", "周五", 1],
    ]);
  });

  it("同一部片的两场只计 1 部", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Alpha" }),
      show({ code: "002", title_en: "Alpha", start_time: "13:00" }),
    ]);
    expect(buildPosterModel(cat, [row("001"), row("002")], NO_MAP, () => true)!.films).toBe(1);
  });

  it("同一天只印单日,不印区间", () => {
    const cat = catalog([show({ code: "001" })]);
    expect(buildPosterModel(cat, [row("001")], NO_MAP, () => true)!.range).toBe("OCT 8");
  });

  it("乱序输入按「日期 → 开场时间」排(与分享文案同源)", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Late", start_time: "18:00" }),
      show({ code: "002", title_en: "Early", start_time: "09:00" }),
      show({ code: "003", title_en: "NextDay", date: "2026-10-09", start_time: "08:00" }),
    ]);
    const model = buildPosterModel(cat, [row("003"), row("001"), row("002")], NO_MAP, () => true)!;
    expect(model.days.map((d) => d.label)).toEqual(["OCT 8", "OCT 9"]);
    expect(model.days[0].rows.map((r) => r.title)).toEqual(["Early", "Late"]);
  });

  it("空输入 / 场次已不在排期里 → null(调用方据此提示「还没有选片」)", () => {
    const cat = catalog([show({ code: "001" })]);
    expect(buildPosterModel(cat, [], NO_MAP, () => true)).toBeNull();
    expect(buildPosterModel(cat, [row("999")], NO_MAP, () => true)).toBeNull();
  });
});

describe("buildPosterModel:单场文案口径", () => {
  it("时间取有效结束,跨午夜印「次日」不印 24+ 制", () => {
    const cat = catalog([
      show({ code: "001", start_time: "23:59", end_time: "29:35", duration_min: 296 }),
    ]);
    const model = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    expect(model.days[0].rows[0].time).toBe("23:59–次日 05:35");
  });

  it("GV 三态:映后 / 仅正片 / 非 GV 无标记", () => {
    const cat = catalog([
      show({ code: "001", is_gv: true }),
      show({ code: "002", is_gv: true }),
      show({ code: "003" }),
    ]);
    const on = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    const off = buildPosterModel(cat, [row("002")], NO_MAP, () => false)!;
    const plain = buildPosterModel(cat, [row("003")], NO_MAP, () => true)!;
    // 文案与分享文案同源(`share.ts::gvMark`):2026-09-16 起「含映后谈」缩成「映后」,chip 更短
    expect(on.days[0].rows[0].gv).toBe("映后");
    expect(off.days[0].rows[0].gv).toBe("仅正片");
    expect(plain.days[0].rows[0].gv).toBe("");
    // 谈段时长(默认 25min)计入结束时间
    expect(on.days[0].rows[0].time).toBe("10:00–12:05");
    expect(off.days[0].rows[0].time).toBe("10:00–11:40");
  });

  it("影院走短名,片名走「英文名 · 中文名」,CODE 随行", () => {
    const cat = catalog([show({ code: "001", title_en: "Alpha", title_zh: "阿尔法" })]);
    const r = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!.days[0].rows[0];
    expect(r.venue).toBe("BCC 1");
    expect(r.title).toBe("Alpha · 阿尔法");
    expect(r.code).toBe("001");
  });

  it("备注进 note 字段(分享图单独一行,不与影院挤在一起)", () => {
    const cat = catalog([show({ code: "001" })]);
    const model = buildPosterModel(cat, [row("001", { note: "导演到场" })], NO_MAP, () => true)!;
    expect(model.days[0].rows[0].note).toBe("导演到场");
  });
});

describe("posterHeight", () => {
  it("有备注的行更高(海报必须按内容算总高,不能写死)", () => {
    const cat = catalog([show({ code: "001" })]);
    const plain = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    const noted = buildPosterModel(cat, [row("001", { note: "映后 Q&A" })], NO_MAP, () => true)!;
    expect(posterHeight(noted)).toBeGreaterThan(posterHeight(plain));
  });

  it("每多一场就多一行的高度;日期分节头本身也占高度", () => {
    const cat = catalog([
      show({ code: "001" }),
      show({ code: "002", start_time: "13:00", end_time: "14:40" }),
      show({ code: "003", date: "2026-10-09", start_time: "08:00" }),
    ]);
    const one = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    const sameDay = buildPosterModel(cat, [row("001"), row("002")], NO_MAP, () => true)!;
    const twoDays = buildPosterModel(cat, [row("001"), row("003")], NO_MAP, () => true)!;
    expect(posterHeight(sameDay)).toBeGreaterThan(posterHeight(one));
    // 两场同样多,但分两天 → 多出一个日期分节头(+ 分节间距)
    expect(posterHeight(twoDays)).toBeGreaterThan(posterHeight(sameDay));
  });

  it("备选行会让行更高(总高与会画出来的行数必须同步,否则 canvas 会把内容裁掉)", () => {
    const cat = catalog([show({ code: "001" }), show({ code: "002", start_time: "13:00", end_time: "14:40" })]);
    const plain = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    const ranked = buildPosterModel(cat, [row("001")], NO_MAP, () => true, {
      ranking: ranking({ "001": 1, "002": 2 }, [["001", "002"]]),
    })!;
    expect(ranked.days[0].rows[0].alts).toHaveLength(1);
    expect(posterHeight(ranked)).toBeGreaterThan(posterHeight(plain));
  });
});

describe("buildPosterModel:顺位 / 备选 / 开票批次(与分享文案同一份 ShareOptions)", () => {
  it("不勾选时:无顺位、无备选、单一无名节(与没有这两个开关的老图一致)", () => {
    const cat = catalog([show({ code: "001" })]);
    const model = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].heading).toBeNull();
    expect(model.days[0].rows[0].rank).toBeUndefined();
    expect(model.days[0].rows[0].alts).toEqual([]);
  });

  it("带顺位:场次带 rank,同冲突组的其余场次成为备选(CODE / 时间 / 片名 / 影院 / 顺位)", () => {
    const cat = catalog([
      show({ code: "001", title_en: "Alpha" }),
      show({ code: "002", title_en: "Beta", start_time: "13:00", end_time: "14:40" }),
    ]);
    const model = buildPosterModel(cat, [row("001")], NO_MAP, () => true, {
      ranking: ranking({ "001": 1, "002": 2 }, [["001", "002"]]),
    })!;
    const r = model.days[0].rows[0];
    expect(r.rank).toBe(1);
    expect(r.alts).toEqual([
      { code: "002", time: "13:00–14:40", title: "Beta", venue: "BCC 1", rank: 2 },
    ]);
  });

  it("共同场次没有顺位(不兜底成「主选」),备选在排期里查不到时静默跳过", () => {
    const cat = catalog([show({ code: "003" })]);
    const model = buildPosterModel(cat, [row("003")], NO_MAP, () => true, {
      ranking: { rankOf: new Map(), matesOf: () => ["999"] },
    })!;
    expect(model.days[0].rows[0].rank).toBeUndefined();
    expect(model.days[0].rows[0].alts).toEqual([]);
  });

  it("带批次:按批次分节,节头文案来自 headOf;days 是各节的扁平派生(顺序一致)", () => {
    const cat = catalog([
      show({ code: "003", date: "2026-10-07", venue_id: "bt", venue_display: "BCC Roof" }),
      show({ code: "004", date: "2026-10-08" }),
    ]);
    const model = buildPosterModel(cat, [row("003"), row("004")], NO_MAP, () => true, {
      batching: {
        batchOf: (s) => ticketBatchOf(s),
        headOf: (batch) => `第 ${batch} 批 · ${batch === 1 ? "9/17" : "9/21"} 14:00 KST`,
      },
    })!;
    expect(model.sections.map((s) => s.heading)).toEqual([
      "第 1 批 · 9/17 14:00 KST",
      "第 2 批 · 9/21 14:00 KST",
    ]);
    // days 是派生视图:拍平后与各节里的天一一对应(供不看批次的消费方用)
    expect(model.days).toEqual(model.sections.flatMap((s) => s.days));
    expect(model.days.map((d) => d.rows[0].code)).toEqual(["003", "004"]);
  });

  it("批次节头本身占高度(图上多一条,总高必须跟着涨)", () => {
    const cat = catalog([
      show({ code: "003", venue_id: "bt", venue_display: "BCC Roof" }),
      show({ code: "004", date: "2026-10-09" }),
    ]);
    const flat = buildPosterModel(cat, [row("003"), row("004")], NO_MAP, () => true)!;
    const batched = buildPosterModel(cat, [row("003"), row("004")], NO_MAP, () => true, {
      batching: { batchOf: (s) => ticketBatchOf(s), headOf: (b) => `第 ${b} 批` },
    })!;
    expect(posterHeight(batched)).toBeGreaterThan(posterHeight(flat));
  });
});
