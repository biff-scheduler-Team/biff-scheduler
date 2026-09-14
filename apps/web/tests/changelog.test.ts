// 排期数据更新提示 —— `changelog.ts` 的纯函数口径。
//
// 为什么单测它:这是**唯一**告诉用户「你自己的片变了什么」的地方,而它依赖两条容易写错的口径 ——
//   ① 影片身份必须走 `filmNodeKey()`(官网英文名 → 中文名 → 原始片名三条路),
//      按片名字符串直接比会漏掉后两条,表现是「明明选了这部片,却说没有新排期」;
//   ② `hasUpdate` 必须同时看「有内容」与「未确认」—— 只看版本号会让一次空跑也弹提示。
//
// 2026-09-14 立(`PLAN-20260914192552`)。

import { describe, expect, it, vi } from "vitest";
import {
  addedByVenue,
  changelogHighlights,
  loadChangelog,
  markSeen,
  peekChangelog,
  seenVersion,
} from "../src/changelog";
import { catalog, show } from "./helpers";
import type { Catalog, ChangelogFile, FilmItem } from "../src/types";

const FILMS: FilmItem[] = [
  {
    id: "f001",
    title_en: "Alpha",
    title_zh: "阿尔法",
    title_orig: "アルファ",
    unit: "Gala",
    remark: "",
    year: 2026,
    rating: null,
    rating_count: null,
    country: "日本",
    director: "某人",
  },
];

const FILE: ChangelogFile = {
  generated_at: "2026-09-14T19:30:00+08:00",
  schedule_generated_at: "v2",
  base_schedule_generated_at: "v1",
  added: [
    // ① 目录**英文名**命中
    { code: "901", title_en: "Alpha", date: "2026-10-08", start_time: "10:00", end_time: "11:40",
      duration_min: 100, venue_id: "m1", venue_display: "MEGABOX 1", is_gv: false },
    // ② 目录**原始片名**命中(片名与 title_en 不同 → 字符串比会漏)
    { code: "902", title_en: "アルファ", date: "2026-10-08", start_time: "13:00", end_time: "14:40",
      duration_min: 100, venue_id: "m2", venue_display: "MEGABOX 2", is_gv: false },
    // ③ 与用户无关
    { code: "903", title_en: "Something Else", date: "2026-10-08", start_time: "15:00", end_time: "16:40",
      duration_min: 100, venue_id: "m3", venue_display: "MEGABOX 3", is_gv: false },
  ],
  changed: [
    { code: "002", title_en: "Closing", title_zh: "闭幕", date: "2026-10-15", venue_display: "BCC Roof",
      fields: [{ key: "duration_min", label: "片长", from: "120", to: "240" }] },
    { code: "999", title_en: "Untouched", title_zh: "", date: "2026-10-15", venue_display: "BCC 1",
      fields: [{ key: "tags", label: "场次标记", from: "—", to: "midnight" }] },
  ],
};

const CAT: Catalog = catalog(
  [show({ code: "002", title_en: "Closing", title_zh: "闭幕" })],
  FILMS,
);

const scope = (seen: string) => ({
  codes: new Set(["002"]), // 我行程里只有 002
  filmKeys: new Set(["cat:f001"]), // 我选了 Alpha(`filmNodeKey` 产出)
  seen,
});

describe("changelog:加载降级", () => {
  it("产物拉不到时静默降级(不抛、不提示)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await loadChangelog();
    expect(peekChangelog()).toBeNull();
    const hl = changelogHighlights(CAT, scope(""));
    expect(hl.hasUpdate).toBe(false);
    expect(hl.mine).toEqual([]);
    expect(hl.addedTotal).toBe(0);
    vi.unstubAllGlobals();
  });

  it("结构不对(缺 added)也当没有,不崩", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ changed: [] }) })));
    await loadChangelog();
    expect(peekChangelog()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("localStorage 不可用(隐私模式)时读写都不抛", () => {
    expect(seenVersion()).toBe("");
    expect(() => markSeen("v2")).not.toThrow();
  });
});

describe("changelog:与我相关的三组", () => {
  it("加载成功后按「我的场次 / 我选过的影片 / 其余」分组", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => FILE })));
    await loadChangelog();
    vi.unstubAllGlobals();
    expect(peekChangelog()?.schedule_generated_at).toBe("v2");

    const hl = changelogHighlights(CAT, scope("v1"));
    expect(hl.mine.map((c) => c.code)).toEqual(["002"]); // 999 不在我行程里
    // 901(英文名)与 902(原始片名)都必须命中 —— 这是 `filmNodeKey` 两条不同路径
    expect(hl.myFilmsAdded.map((s) => s.code)).toEqual(["901", "902"]);
    expect(hl.othersAdded.map((s) => s.code)).toEqual(["903"]);
    expect(hl.addedTotal).toBe(3);
    expect(hl.relevant).toBe(3); // 1 场变化 + 2 场新排期
    expect(hl.hasUpdate).toBe(true);
  });

  it("版本已确认 → 不再提示(但内容仍可读)", () => {
    const hl = changelogHighlights(CAT, scope("v2"));
    expect(hl.hasUpdate).toBe(false);
    expect(hl.mine).toHaveLength(1);
  });

  it("没选任何片 → 三组里没有「我的」,但新增概况仍在", () => {
    const hl = changelogHighlights(CAT, { codes: new Set(), filmKeys: new Set(), seen: "v1" });
    expect(hl.mine).toEqual([]);
    expect(hl.myFilmsAdded).toEqual([]);
    expect(hl.othersAdded).toHaveLength(3);
    expect(hl.relevant).toBe(0);
    expect(hl.hasUpdate).toBe(true); // 没选片也值得知道「新同步了 3 场」
  });
});

describe("changelog:概况分组", () => {
  it("按影院归并且保持首次出现顺序", () => {
    const groups = addedByVenue(FILE.added);
    expect(groups.map((g) => g.venue)).toEqual(["MEGABOX 1", "MEGABOX 2", "MEGABOX 3"]);
    expect(groups[0].list.map((s) => s.code)).toEqual(["901"]);
  });
});
