// 开票批次口径单测（2026-09-15 新增「抢票」页 / 分享文案批次分节）。
// 为什么单测它：批次判错 = 用户错过第一批开票（9/17 14:00 KST）—— 后果是**买不到票**，
// 而判据全是「标签 / 场地 / 活动类型」的组合，只有断言能守住。
// 覆盖点：① 五种判据各一条；② 优先级（露天覆盖单元）；③ **室内重映必须落第 2 批**（回归）；
//        ④ 判据说明与批次同源；⑤ 分组顺序 / 组内排序 / 空批不输出 / 缺 code 跳过。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BATCH_CATEGORY_EN,
  batchReasonOf,
  groupCodesByBatch,
  ticketBatchOf,
  type BatchContext,
} from "../src/batch";
import type { ScheduleFile, Screening } from "../src/types";
import { catalog, show } from "./helpers";

/** 活动类型查询：`kindOf` 注入（生产侧来自 `festival-extras.json` 的 `programs[].kind`） */
function kinds(map: Record<string, string>): BatchContext {
  return { kindOf: (code) => map[code] };
}

describe("ticketBatchOf：五种判据", () => {
  it("开闭幕（tags opening / closing）→ 第 1 批", () => {
    expect(ticketBatchOf(show({ code: "001", tags: ["opening"] }))).toBe(1);
    expect(ticketBatchOf(show({ code: "002", tags: ["closing"] }))).toBe(1);
  });

  it("Midnight Passion（tags midnight）→ 第 1 批", () => {
    expect(ticketBatchOf(show({ code: "269", tags: ["midnight"], start_time: "23:59" }))).toBe(1);
  });

  it("露天剧场（venue_id bt）→ 第 1 批（Open Cinema）", () => {
    // 官方公布的 8 部 Open Cinema 里，Look Back 的单元是 Gala Presentation ——
    // 判据只认场地，所以单元不参与判定（见 batch.ts 文件头 ③）。
    expect(ticketBatchOf(show({ code: "003", venue_id: "bt", start_time: "20:00" }))).toBe(1);
    expect(ticketBatchOf(show({ code: "466", venue_id: "bt", start_time: "20:00" }))).toBe(1);
    expect(ticketBatchOf(show({ code: "554", venue_id: "bt", start_time: "20:00" }))).toBe(1);
  });

  it("Community BIFF（官方编号 901–942）→ 第 1 批", () => {
    expect(ticketBatchOf(show({ code: "901", venue_id: "m1" }))).toBe(1);
    expect(ticketBatchOf(show({ code: "942", venue_id: "m4" }))).toBe(1);
    expect(batchReasonOf(show({ code: "903" }))).toBe("Community BIFF");
    // 编号段只认三位 9 开头:8xx 的活动场(Actors' House / Special Talk)不受影响
    expect(ticketBatchOf(show({ code: "899" }))).toBe(2);
    expect(ticketBatchOf(show({ code: "831" }), kinds({ "831": "special_talk" }))).toBe(2);
  });

  it("Actors' House（活动 kind = actors_house）→ 第 1 批", () => {
    expect(ticketBatchOf(show({ code: "801" }), kinds({ "801": "actors_house" }))).toBe(1);
  });

  it("其余一律第 2 批（Master Class / Cine Class / Special Talk / 一般放映）", () => {
    expect(ticketBatchOf(show({ code: "004" }))).toBe(2);
    expect(ticketBatchOf(show({ code: "831" }), kinds({ "831": "special_talk" }))).toBe(2);
    expect(ticketBatchOf(show({ code: "808" }), kinds({ "808": "master_class" }))).toBe(2);
    expect(ticketBatchOf(show({ code: "821" }), kinds({ "821": "cine_class" }))).toBe(2);
    // 活动类型取不到（extras 未加载 / 缺文件）时不误判进第 1 批
    expect(ticketBatchOf(show({ code: "801" }))).toBe(2);
  });
});

describe("ticketBatchOf：露天 vs 单元（回归）", () => {
  // 同一部片在本届既有露天场（第 1 批）也有室内重映（第 2 批）——
  // 按影片单元判会把室内场误判进第 1 批：724 / 393 / 229 / 546 四场实测如此。
  const indoor: Screening = show({
    code: "724",
    venue_id: "sh",
    start_time: "12:20",
    title_en: "In the Clear Moonlit Dusk",
  });
  const outdoor: Screening = show({
    code: "070",
    venue_id: "bt",
    start_time: "20:00",
    title_en: "In the Clear Moonlit Dusk",
  });

  it("室内重映落第 2 批，露天场落第 1 批", () => {
    expect(ticketBatchOf(indoor)).toBe(2);
    expect(ticketBatchOf(outdoor)).toBe(1);
  });

  it("同片两场批次可以不同（批次是场次级，不是影片级）", () => {
    expect(ticketBatchOf(indoor)).not.toBe(ticketBatchOf(outdoor));
  });
});

describe("batchReasonOf：判据说明与批次同源", () => {
  it("每个批次都给出人话说明", () => {
    expect(batchReasonOf(show({ code: "001", tags: ["opening"] }))).toBe("开闭幕");
    expect(batchReasonOf(show({ code: "269", tags: ["midnight"] }))).toBe("Midnight Passion");
    expect(batchReasonOf(show({ code: "070", venue_id: "bt" }))).toBe("Open Cinema（露天放映）");
    expect(batchReasonOf(show({ code: "801" }), kinds({ "801": "actors_house" }))).toBe("Actors' House");
    expect(batchReasonOf(show({ code: "004" }))).toBe("一般放映");
  });

  it("官网品类原文两批都有（页面横幅直接印它，不翻译）", () => {
    expect(BATCH_CATEGORY_EN[1]).toContain("Open Cinema");
    expect(BATCH_CATEGORY_EN[1]).toContain("Community BIFF");
    expect(BATCH_CATEGORY_EN[2]).toContain("General Screenings");
  });
});

describe("真实排期:第 1 批覆盖面", () => {
  // 这两条用真实 `public/schedule.json` —— 判据错一次就是「用户错过第一批开票」,
  // 而合成夹具看不出「这 42 场到底在不在排期里」这种数据事实。
  const schedule = JSON.parse(readFileSync("public/schedule.json", "utf8")) as ScheduleFile;

  it("Community BIFF 的 42 场(官方编号 901–942)全部落第 1 批", () => {
    const community = schedule.screenings.filter((s) => /^9\d\d$/.test(s.code));
    expect(community).toHaveLength(42);
    expect(community.every((s) => ticketBatchOf(s) === 1)).toBe(true);
  });

  it("露天剧场(bt)每晚 20:00 的 8 场 = 官方 Open Cinema 片单,全部落第 1 批", () => {
    const outdoor = schedule.screenings.filter(
      (s) => s.venue_id === "bt" && s.start_time === "20:00"
    );
    expect(outdoor).toHaveLength(8);
    expect(outdoor.every((s) => ticketBatchOf(s) === 1)).toBe(true);
  });

  it("同片的室内重映落第 2 批(露天判据只看场地,不看片名 / 单元)", () => {
    // 724 = In the Clear Moonlit Dusk 在 Sohyang Theatre 的室内场(与露天场 070 同片)
    const indoor = schedule.screenings.filter((s) => s.code === "724");
    expect(indoor).toHaveLength(1);
    expect(ticketBatchOf(indoor[0])).toBe(2);
  });
});

describe("groupCodesByBatch", () => {
  it("批次顺序固定 1 → 2，空批次不出现，组内按「日期 → 开场时间」排", () => {
    const cat = catalog([
      show({ code: "004", date: "2026-10-07", start_time: "15:00" }),
      show({ code: "002", tags: ["closing"], date: "2026-10-15", start_time: "18:00" }),
      show({ code: "001", tags: ["opening"], date: "2026-10-06", start_time: "18:00" }),
    ]);
    const groups = groupCodesByBatch(cat, ["004", "002", "001"]);
    expect(groups.map((g) => g.batch)).toEqual([1, 2]);
    expect(groups[0].screenings.map((s) => s.code)).toEqual(["001", "002"]);
    expect(groups[1].screenings.map((s) => s.code)).toEqual(["004"]);
  });

  it("只有一批时另一批不出现", () => {
    const cat = catalog([show({ code: "004" })]);
    expect(groupCodesByBatch(cat, ["004"]).map((g) => g.batch)).toEqual([2]);
  });

  it("排期里已不存在的 code 静默跳过（换版残留）", () => {
    const cat = catalog([show({ code: "004" })]);
    expect(groupCodesByBatch(cat, ["004", "999"]).flatMap((g) => g.screenings.map((s) => s.code))).toEqual(["004"]);
  });

  it("空输入返回空数组", () => {
    expect(groupCodesByBatch(catalog([]), [])).toEqual([]);
  });
});
