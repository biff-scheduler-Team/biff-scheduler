// 分享图片(行程图)模型单测(2026-09-11 新增)。
// 只测 `poster.ts::buildPosterModel` / `posterHeight` —— **绘制层不测**(canvas 在 node 里没有)。
// 覆盖点:① 日期分节 + 概要计数;② 内部排序(乱序输入也按日期 / 时间排);
//        ③ 跨午夜印「次日」不印 24+ 制;④ GV 三态;⑤ 备注行与行高;
//        ⑥ 影院短名与「英文名 · 中文名」片名口径;⑦ 空输入 / 已下架场次。

import { describe, expect, it } from "vitest";
import type { PickRow } from "../src/ics";
import { buildPosterModel, posterHeight } from "../src/poster";
import type { Mapping } from "../src/types";
import { catalog, show } from "./helpers";

const NO_MAP = new Map<string, Mapping>();

/** 一条已选场次(默认无备注) */
function row(code: string, patch: Partial<PickRow> = {}): PickRow {
  return { code, note: "", ...patch };
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

  it("GV 三态:含映后谈 / 仅正片 / 非 GV 无标记", () => {
    const cat = catalog([
      show({ code: "001", is_gv: true }),
      show({ code: "002", is_gv: true }),
      show({ code: "003" }),
    ]);
    const on = buildPosterModel(cat, [row("001")], NO_MAP, () => true)!;
    const off = buildPosterModel(cat, [row("002")], NO_MAP, () => false)!;
    const plain = buildPosterModel(cat, [row("003")], NO_MAP, () => true)!;
    expect(on.days[0].rows[0].gv).toBe("GV 含映后谈");
    expect(off.days[0].rows[0].gv).toBe("GV 仅正片");
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
});
