// P&I(Press & Industry)记者 / 业界场的显示口径 —— **默认不显示**,设置勾选后才并进 catalog。
//
// 为什么单测它:「勾选了却没出现」与「没勾选却混进来」都是**静默失效型** bug ——
// 不报类型错、不报运行错,表现只是场次多/少了几十条。这里把两条口径都钉住。
//
// 2026-09-16 立(`PLAN-20260916182254`)。

import { describe, expect, it } from "vitest";
import { hasPni, isPni, withPni } from "../src/pni";
import type { Venue } from "../src/types";
import { catalog, show } from "./helpers";

const normal = show({ code: "001", title_en: "Normal Show", date: "2026-10-06" });
const pniShow = show({
  code: "PI-09-01",
  title_en: "Press Only",
  date: "2026-10-07",
  venue_id: "c7",
  pni: true,
});
const cgv7: Venue = { id: "c7", name: "CGV Centum City 7", name_kr: "", group: "cgv", short: "CGV 7" };
const indieplus: Venue = { id: "bd", name: "BCC Indieplus", name_kr: "", group: "bcc", short: "BCC Indieplus" };

describe("P&I 场次的合并口径", () => {
  it("基础 catalog 不含 P&I:byCode / screenings / venues 都查不到", () => {
    const base = catalog([normal], [], [pniShow], [cgv7]);
    expect(base.byCode.has("PI-09-01")).toBe(false);
    expect(base.schedule.screenings.map((s) => s.code)).toEqual(["001"]);
    expect(base.venues.map((v) => v.id)).not.toContain("c7");
    // 但「有没有 P&I 数据」要答得出来 —— 设置弹层据此决定要不要展示这一项
    expect(hasPni(base)).toBe(true);
  });

  it("withPni 后 P&I 与普通场次一起出现", () => {
    const merged = withPni(catalog([normal], [], [pniShow], [cgv7]));
    expect(merged.schedule.screenings.map((s) => s.code)).toEqual(["001", "PI-09-01"]);
    expect(merged.byCode.get("PI-09-01")?.title_en).toBe("Press Only");
    expect(merged.venueById.has("c7")).toBe(true);
    expect(merged.dates).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("不修改入参(纯函数)—— 取消勾选后 P&I 必须能完全消失", () => {
    const base = catalog([normal], [], [pniShow], [cgv7]);
    withPni(base);
    expect(base.schedule.screenings.map((s) => s.code)).toEqual(["001"]);
    expect(base.byCode.has("PI-09-01")).toBe(false);
    expect(base.venues.map((v) => v.id)).not.toContain("c7");
  });

  it("P&I 厅与同影院(group)的厅挨着排,不撕裂泳道", () => {
    // b1 / b2 是 bcc 组 → Indieplus 应插在 b2 之后;cgv 组不存在 → CGV 7 兜底追加末尾
    const merged = withPni(catalog([normal], [], [pniShow], [indieplus, cgv7]));
    expect(merged.venues.map((v) => v.id)).toEqual(["b1", "b2", "bd", "c7"]);
  });

  it("没有 P&I 数据时原样返回同一引用(旧部署缺 pni.json)", () => {
    const base = catalog([normal]);
    expect(withPni(base)).toBe(base);
    expect(hasPni(base)).toBe(false);
  });

  it("isPni 只认 pni === true", () => {
    expect(isPni(pniShow)).toBe(true);
    expect(isPni(normal)).toBe(false);
    expect(isPni(show({ code: "002", pni: false }))).toBe(false);
  });
});
