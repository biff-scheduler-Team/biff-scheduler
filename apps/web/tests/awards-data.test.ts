// 获奖产物(`public/awards.json`)的**数据哨兵**。
//
// 为什么单测它:产物由离线脚本从官网颁奖报道生成,失效方式全是静默的 ——
// 片名对不上目录(徽章挂不上去)、code 变了(徽章挂到不存在的场次)、
// 官网把「历届得主」也印在同一页(把 2025 / 2024 的得主当本届发出去),都不报错。
//
// 2026-10-15 立(`PLAN-20261015142133`)。
// 实测:脚本没切 `aw-history-divider` 之前,Camellia Award 会多出 2 条历届得主
// (2025 Sylvia CHANG / 2024 RYU Seong-hie)—— 第三条断言就是那条 bug 的哨兵。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface AwardItem {
  award: string;
  awardZh: string | null;
  film: string;
  filmIds: string[];
  codes: string[];
}

interface AwardsFile {
  awards: AwardItem[];
  people: { award: string; name: string }[];
}

const read = (path: string): string => readFileSync(path, "utf8");

const awards = JSON.parse(read("public/awards.json")) as AwardsFile;
const screenings = (JSON.parse(read("public/schedule.json")) as { screenings: { code: string }[] })
  .screenings;
const codes = new Set(screenings.map((s) => s.code));

describe("获奖产物(self-contained,前端只查表)", () => {
  it("每条获奖都落在「一部目录影片」上(片名对不上目录 = 徽章永远挂不上去)", () => {
    const missed = awards.awards.filter((a) => a.filmIds.length === 0).map((a) => `${a.award}: ${a.film}`);
    expect(missed).toEqual([]);
    expect(awards.awards.length).toBeGreaterThanOrEqual(30);
  });

  it("关联的场次 code 全部能对回 schedule.json(不挂到不存在的场次)", () => {
    const stale = awards.awards.flatMap((a) => a.codes.filter((c) => !codes.has(c)).map((c) => `${a.award}:${c}`));
    expect(stale).toEqual([]);
    // 交叉核对必须真有样本,否则上面那条会在「一个 code 都没落」时静默通过
    expect(awards.awards.filter((a) => a.codes.length > 0).length).toBeGreaterThanOrEqual(25);
  });

  it("已下架(removeCodes)的场次不得出现在获奖关联里", () => {
    const cancelled = ["510", "633"];
    expect(awards.awards.flatMap((a) => a.codes).filter((c) => cancelled.includes(c))).toEqual([]);
  });

  it("荣誉奖只收本届:历届得主不得混进来", () => {
    const names = awards.people.map((p) => p.name);
    // 2025 / 2024 的 Camellia Award 得主(官网印在同一页,切 `aw-history-divider` 之前的 bug)
    expect(names).not.toContain("Sylvia CHANG");
    expect(names).not.toContain("RYU Seong-hie");
    expect(names).toContain("Ann HUI");
  });

  it("奖项中文名是人工表:命中就填,未命中留 null(由界面回落英文)", () => {
    expect(awards.awards.every((a) => a.awardZh === null || a.awardZh.length > 0)).toBe(true);
    expect(awards.awards.filter((a) => a.awardZh).length).toBeGreaterThanOrEqual(28);
  });
});
