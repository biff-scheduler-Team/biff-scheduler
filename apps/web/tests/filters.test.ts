// 排片筛选的**语义**单测(纯函数,不碰 DOM)。
//
// 为什么单测它:`matchesFilters` 是网格淡化 / 影片库收窄 / **网格纵轴行去留**的唯一判定,
// 而影厅那道有两套读法(白名单 / 黑名单)—— 口径一旦漂移,表现是「筛了但没筛掉」
// 或「筛选看着没开却什么都不显示」,两者都不报错、不报类型错,只能靠断言守住。

import { describe, expect, it } from "vitest";
import { clearFilter, makeFilterState, matchesFilters, venueAllowed, venueFilterKey } from "../src/filters";
import type { Screening } from "../src/types";

const show = (over: Partial<Screening> = {}): Screening => ({
  code: "001",
  title_en: "Some Film",
  title_kr: "어떤 영화",
  title_zh: "",
  date: "2026-10-08",
  start_time: "10:00",
  end_time: "11:40",
  duration_min: 100,
  venue_id: "b1",
  venue_display: "BCC Cinema 1",
  is_gv: false,
  ...over,
});

describe("影厅筛选:白名单 / 黑名单两套读法", () => {
  it("空集 = 全部通过(两种模式都一样)", () => {
    for (const mode of ["include", "exclude"] as const) {
      const f = makeFilterState();
      f.venueMode = mode;
      expect(venueAllowed("b1", f)).toBe(true);
      expect(venueAllowed("sh", f)).toBe(true);
      expect(matchesFilters(show(), f)).toBe(true);
    }
  });

  it("include:只放行选中的厅", () => {
    const f = makeFilterState();
    f.venues.add("b1");
    expect(venueAllowed("b1", f)).toBe(true);
    expect(venueAllowed("c1", f)).toBe(false);
    expect(matchesFilters(show({ venue_id: "c1" }), f)).toBe(false);
  });

  it("exclude:只放行**未**选中的厅(「只去掉最后几个」的核心)", () => {
    const f = makeFilterState();
    f.venueMode = "exclude";
    f.venues.add("sh");
    f.venues.add("bcm");
    expect(venueAllowed("sh", f)).toBe(false);
    expect(venueAllowed("bcm", f)).toBe(false);
    expect(venueAllowed("b1", f)).toBe(true);
    expect(matchesFilters(show({ venue_id: "b1" }), f)).toBe(true);
  });

  it("clearFilter 把模式一并复位(否则「清除」后仍停在黑名单读法上)", () => {
    const f = makeFilterState();
    f.venueMode = "exclude";
    f.venues.add("sh");
    clearFilter(f);
    expect(f.venueMode).toBe("include");
    expect(f.venues.size).toBe(0);
  });

  it("几何签名:模式 / 集合变化都会变(行数会变 ⇒ 必须触发网格重建)", () => {
    const f = makeFilterState();
    expect(venueFilterKey(f)).toBe(""); // 空串 = 无影厅筛选,与旧签名逐字兼容
    f.venues.add("b1");
    const inc = venueFilterKey(f);
    f.venueMode = "exclude";
    expect(venueFilterKey(f)).not.toBe(inc);
    f.venues.add("b2");
    expect(venueFilterKey(f)).not.toBe(inc);
  });
});
