// 官网**下架场次**(排期页的 `var removeCodes = [...]`)不得出现在公开排期里。
//
// 为什么单测它:官网下架后**格子仍然印在 HTML 里**,只是靠前端 JS 摘掉 ——
// 抓取脚本不认这行就会把已取消的场次当成正常场次收进来,而且**没有任何报错**,
// 用户看到的是「排片表里有一场根本买不到票的放映」。
// 2026-10-09 官方公告 `Red Thread` 因制片方撤片下架:普通场次 510 / 633 取消,
// 午夜场 168 的成员由 `Red Thread` 换成 `Spirit Guardians: The Last Secret Of The First Emperor`。
//
// 2026-10-15 立(`PLAN-20261015142133`)。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

/** 片名归一(与 `tools/scrape_biff_web.py::norm_title` 同口径)。 */
const norm = (s: string): string => s.toLowerCase().replace(/[^0-9a-z\uac00-\ud7a3]+/g, "");

interface Screening {
  code: string;
  title_en: string;
  date: string;
  venue_id: string;
  midnight_members?: string[];
}

const screenings = (JSON.parse(read("public/schedule.json")) as { screenings: Screening[] }).screenings;
const byCode = new Map(screenings.map((s) => [s.code, s]));

/** 官网 `removeCodes` 里已下架的编号(与 tools/scrape_biff_web.py 的 cancelled.json 同源)。 */
const CANCELLED_CODES = ["510", "633"];

describe("官网下架(removeCodes)的场次不得进公开排期", () => {
  it("510 / 633(Red Thread 撤片)已剔除", () => {
    expect(CANCELLED_CODES.filter((c) => byCode.has(c))).toEqual([]);
  });

  it("801(Actors' House: LEE Minho)已剔除 —— 官网排期已不列,虽未进 removeCodes", () => {
    // 2026-10-15 重抓发现:该场次原本来自官网(9/11 产物里有),现在官网 10/07 页面上
    // 连格子都没有了,但**不在** removeCodes 里 —— 所以「以官网为准」是唯一正确口径。
    expect(byCode.has("801")).toBe(false);
  });

  it("撤片影片在排期里一场都不剩(按片名兜底,不只看编号)", () => {
    const redThread = screenings
      .filter((s) => norm(s.title_en) === norm("Red Thread"))
      .map((s) => `${s.code} ${s.date} ${s.venue_id}`);
    expect(redThread).toEqual([]);
  });

  it("午夜场 168 的联映块成员跟着官网换片", () => {
    const members = byCode.get("168")?.midnight_members ?? [];
    expect(members.map(norm)).toContain(norm("Spirit Guardians: The Last Secret Of The First Emperor"));
    expect(members.map(norm)).not.toContain(norm("Red Thread"));
  });

  it("剔除只影响这三场:册子独有的 901–942 仍一场不少", () => {
    const codes = Array.from({ length: 42 }, (_v, i) => String(901 + i));
    expect(codes.filter((c) => !byCode.has(c))).toEqual([]);
    // 795(上一版) − 510/633(撤片) − 801(官网下架)
    expect(screenings.length).toBe(792);
  });
});
