// 官方付印册子(Ticket Catalogue PDF)并入产物后的**数据口径哨兵**。
//
// 为什么单测它:册子补进来的东西(南浦洞 MEGABOX 的 42 场、官网兜底片长、影片介绍页字段)
// 都是**静默失效型**——重跑一次抓取脚本就会整批消失,不报类型错也不报运行错,
// 表现只是「少了 80 场」或「首映标记没了」。这里把每条口径钉住。
//
// 2026-09-14 立(`PLAN-20260914184902`)。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

/** 片名归一(与 `tools/extract_catalogue_films.py::norm_title` 同口径)。 */
const norm = (s: string): string => s.toLowerCase().replace(/[^0-9a-z\uac00-\ud7a3]+/g, "");

interface Screening {
  code: string;
  title_en: string;
  /** 活动场次中文名(2026-09-16 起由 data/event-titles-2026.json 补,见文件末尾哨兵) */
  title_zh?: string;
  date: string;
  end_time: string;
  duration_min: number;
  venue_id: string;
  page?: number;
  tags?: string[];
}
interface Venue {
  id: string;
  group: string;
  code?: string;
}
interface Film {
  title_en?: string;
  title_zh?: string;
  catalogue?: {
    page: number;
    format?: string | null;
    premiere?: string | null;
    synopsis_en?: string | null;
    synopsis_ko?: string | null;
  };
}

const screenings = (JSON.parse(read("public/schedule.json")) as { screenings: Screening[] }).screenings;
const venues = (JSON.parse(read("public/venues.json")) as { venues: Venue[] }).venues;
const films = (JSON.parse(read("public/films.json")) as { films: Film[] }).films;
const extras = JSON.parse(read("public/festival-extras.json")) as {
  ticketing: {
    ticketBoxes?: { place: string; period: string; payment: string }[];
    venueRules?: { source: string; items: { text: string; notes: string[] }[] };
  };
};
const byCode = new Map(screenings.map((s) => [s.code, s]));

describe("册子补入的场馆(MEGABOX / Roof Theater)", () => {
  it("新增 5 个厅,且 Roof Theater 用官方代码 bt(不是抓取脚本自造的 br)", () => {
    const ids = venues.map((v) => v.id);
    for (const id of ["m1", "m2", "m3", "m4", "bt"]) {
      expect(ids, `缺场馆 ${id}`).toContain(id);
    }
    expect(ids).not.toContain("br");
    expect(venues.find((v) => v.id === "bt")?.code).toBe("BT");
    expect(venues.find((v) => v.id === "m1")?.group).toBe("megabox");
  });

  it("每场放映的 venue_id 都在 venues.json 里(否则甘特图会出现没有行标签的泳道)", () => {
    const known = new Set(venues.map((v) => v.id));
    const missing = [...new Set(screenings.map((s) => s.venue_id))].filter((id) => !known.has(id));
    expect(missing).toEqual([]);
  });
});

describe("官网排期页不列、只有册子有的场次", () => {
  it("MEGABOX Community BIFF 的官方编号 901–942 全在(42 场)", () => {
    const codes = Array.from({ length: 42 }, (_v, i) => String(901 + i));
    expect(codes.filter((c) => !byCode.has(c))).toEqual([]);
    expect(codes.every((c) => byCode.get(c)?.venue_id.startsWith("m"))).toBe(true);
  });

  // ★ 哨兵:Indieplus(BD)/ CGV 7(C7) 是册子的 **P&I(Press & Industry) Screenings** 两列
  // (粉底、不印编号、官网排期页与影片介绍页都不列)—— 记者/业界场,**不对外售票**,
  // 不该出现在公开排期里。2026-09-14 曾用合成的 `X<页><序>` 编号把它们混进来 37 场,
  // 现按「不印编号 = 非公开」跳过。片名是用户最容易在册子上核对的东西 ——
  // 编号一旦是合成的,用户永远找不到它,这是最伤的信任损失。
  it("P&I 场次(Indieplus / CGV 7)不得进入公开排期", () => {
    expect(screenings.filter((s) => s.venue_id === "bd")).toEqual([]);
    expect(screenings.filter((s) => s.venue_id === "c7")).toEqual([]);
    expect(venues.map((v) => v.id)).not.toContain("bd");
    expect(venues.map((v) => v.id)).not.toContain("c7");
    // 合成号一律不得出现(官网那条 BAFA 典礼是唯一例外:官网自己印 `-` 表示无编号)
    const synthetic = screenings.map((s) => s.code).filter((c) => /^X/.test(c) && c !== "X01");
    expect(synthetic).toEqual([]);
  });

  it("Midnight Passion 联映块带 midnight 标记(官网那条没标,取自册子)", () => {
    expect(byCode.get("075")?.tags).toContain("midnight");
  });
});

describe("片长:官网无详情页时用册子印的值覆盖官网的 120′ 兜底", () => {
  it("002 闭幕式 = 240′(官网是 FALLBACK 120′)", () => {
    expect(byCode.get("002")?.duration_min).toBe(240);
    expect(byCode.get("002")?.end_time).toBe("22:00");
  });

  it("731–735 获奖片重映 = 册子印的片长", () => {
    expect([731, 732, 733, 734, 735].map((c) => byCode.get(String(c))?.duration_min)).toEqual([
      160, 150, 150, 150, 130,
    ]);
  });

  it("831 Special Talk 保留官网的 120′(9/10 付印后官网改过,册子的 60′ 已过期)", () => {
    expect(byCode.get("831")?.duration_min).toBe(120);
    expect(byCode.get("831")?.end_time).toBe("22:00");
  });

  it("解析器不再把片长首位数字吞掉(206 / 313 / 317)", () => {
    expect(byCode.get("206")?.duration_min).toBe(120);
    expect(byCode.get("313")?.duration_min).toBe(107);
    expect(byCode.get("317")?.duration_min).toBe(101);
  });
});

describe("影片介绍页字段(官网片目页不印)", () => {
  const withCatalogue = films.filter((f) => f.catalogue);

  it("覆盖面过半,且每条都有册页号与格式", () => {
    expect(withCatalogue.length).toBeGreaterThan(films.length / 2);
    expect(withCatalogue.every((f) => (f.catalogue?.page ?? 0) > 0)).toBe(true);
    expect(withCatalogue.every((f) => f.catalogue?.format)).toBe(true);
  });

  it("首映码只用 WP / IP(未登记的码不猜,先补表)", () => {
    const codes = new Set(withCatalogue.map((f) => f.catalogue?.premiere).filter(Boolean));
    expect([...codes].sort()).toEqual(["IP", "WP"]);
  });

  it("开幕片有世界首映标记与英韩双语简介", () => {
    const opening = films.find((f) => f.title_en === "The Table: Day and Night");
    expect(opening?.catalogue?.premiere).toBe("WP");
    expect(opening?.catalogue?.synopsis_en).toBeTruthy();
    expect(opening?.catalogue?.synopsis_ko).toBeTruthy();
  });

  // ★ 坐标系哨兵:册页号有两个来源 —— 排期格子里印的(Screening.page,印刷页号)与
  // 影片介绍页解析出来的(FilmItem.catalogue.page)。一张 PDF 页 = 一个**跨页**(印着两个页码),
  // 解析时忘了「PDF 页 → 印刷页」换算,`catalogue.page` 会整体差一倍,而字段本身看着完全正常
  // (实测 217 条全错:`The Table` 写成 22,实际 43)。同一部片两个来源必须落在同一集合里。
  it("册页号与排期印的一致(印刷页号坐标系,不是 PDF 页下标)", () => {
    const pagesByTitle = new Map<string, Set<number>>();
    for (const s of screenings) {
      if (!s.page) continue;
      const key = norm(s.title_en);
      const set = pagesByTitle.get(key) ?? new Set<number>();
      set.add(s.page);
      pagesByTitle.set(key, set);
    }
    const mismatched = withCatalogue
      .filter((f) => {
        const pages = pagesByTitle.get(norm(f.title_en ?? ""));
        return pages && !pages.has(f.catalogue!.page);
      })
      .map((f) => `${f.title_en}: ${f.catalogue!.page}`);
    expect(mismatched).toEqual([]);
    // 交叉核对必须真的有样本,否则这条断言会在「两个来源都没数据」时静默通过
    expect(withCatalogue.filter((f) => pagesByTitle.has(norm(f.title_en ?? ""))).length)
      .toBeGreaterThan(100);
  });
});

describe("排期更新日志产物(changelog.json)", () => {
  const changelog = JSON.parse(read("public/changelog.json")) as {
    schedule_generated_at: string;
    added: unknown[];
    changed: unknown[];
  };
  const schedule = JSON.parse(read("public/schedule.json")) as {
    festival: { generated_at?: string };
  };

  it("版本号与排期自身的生成时间一致(前端拿它当版本比对)", () => {
    expect(changelog.schedule_generated_at).toBe(schedule.festival.generated_at);
  });

  it("本次确实记录了册子并入带来的新增与变化", () => {
    expect(changelog.added.length).toBeGreaterThan(0);
    expect(changelog.changed.length).toBeGreaterThan(0);
  });
});

describe("票务补充字段", () => {
  it("票亭表 8 处(含南浦洞 MEGABOX 4F),且每处都有运营期", () => {
    expect(extras.ticketing.ticketBoxes).toHaveLength(8);
    expect(extras.ticketing.ticketBoxes?.every((b) => b.period && b.place)).toBe(true);
    expect(extras.ticketing.ticketBoxes?.some((b) => b.place.includes("MEGABOX"))).toBe(true);
  });

  it("入场与观影规则来自册子(官网售票页不印这一节)", () => {
    const rules = extras.ticketing.venueRules;
    expect(rules?.items.length).toBeGreaterThanOrEqual(6);
    expect(rules?.source).toContain("Ticket Catalogue");
    expect(rules?.items.some((r) => r.text.includes("15 minutes after the screening starts"))).toBe(true);
    // 附注必须挂在条目上,不能被拼进正文
    expect(rules?.items.some((r) => r.notes.length > 0)).toBe(true);
  });
});

// 活动场次中文名(2026-09-16 立,`PLAN-20260916142713`):
// Actors' House / Master Class / Cine Class / Special Talk 在**影片目录里没有条目**,
// 抓取脚本的目录反查必然落空 → 这批场次曾经只有英文名。中文名的唯一来源是
// `data/event-titles-2026.json`(人工表),由 `scrape_biff_web.py --event-titles` 与
// `tools/apply_event_titles.py` 共用同一份匹配。三条断言分别钉:①补了、②表与产物没漂、
// ③译文不与任何片名撞车(撞车会让 `filmNodeKey` 把活动误当归并到某部片)。
describe("活动场次的中文名(人工活动译名表)", () => {
  const ACTIVITY_CODES = [
    "801", "802", "803", "804", "805", "806", // Actors' House
    "811", "812", "813", "814", // Master Class
    "821", "822", "823", "824", "825", "826", // Cine Class
    "831", // Special Talk
  ];
  const eventTitles = JSON.parse(read("../../data/event-titles-2026.json")) as {
    events: Record<string, string>;
  };
  const zhOf = (code: string): string => (byCode.get(code)?.title_zh ?? "").trim();

  it("17 场活动场次都有中文名(全空 = 本轮需求原先的症状)", () => {
    const missing = ACTIVITY_CODES.filter((c) => !zhOf(c));
    expect(missing.map((c) => `${c} ${byCode.get(c)?.title_en ?? "?"}`)).toEqual([]);
  });

  it("活动译名表逐条落进产物(表改了就必须重跑 apply/抓取)", () => {
    const zhSet = new Set(Object.values(eventTitles.events));
    const drifted = ACTIVITY_CODES.filter((c) => !zhSet.has(zhOf(c)));
    expect(drifted.map((c) => `${c} ${zhOf(c)}`)).toEqual([]);
  });

  it("活动中文名不与影片目录任何片名相同", () => {
    const filmTitles = new Set(films.map((f) => f.title_zh).filter((t): t is string => Boolean(t)));
    const clash = ACTIVITY_CODES.map(zhOf).filter((zh) => filmTitles.has(zh));
    expect(clash).toEqual([]);
  });
});
