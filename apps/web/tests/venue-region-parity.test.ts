// 影院「分区」口径一致性 —— 三个来源必须逐字对齐：
//   ① apps/web/public/venues.json 的 `region`（数据，唯一真源）
//   ② apps/web/src/legend.ts::GROUP_AREA（新版展示文案）
//   ③ apps/web/legacy/src/legend.ts::GROUP_AREA（旧版展示文案，冻结件）
//
// 为什么单测它：2026-09-14 现场反馈「东西大学 Sohyang Theatre 显示分区在南浦洞」——
// 根因是 2025 导入时把 sohyang / bcm 误归 nampo（与官方三区模型相左，见
// docs/history/2026-09-09-开发落地记录.md:263：Centum 主场区含 Sohyang / Community Media Center），
// 新版重写时按官网口径纠正成 centum，旧版作为冻结件把错误留在原地。
// 这类漂移**不报类型错、不报运行错**，表现只是「同一家影院在两个入口显示不同分区」，
// 只能靠断言守住 —— 所以数据（venues.json）必须是判定基准，而不是拿其中一版去对另一版。
//
// ⚠ 旧版按**源码文本**读而不是 import：它是逐字节冻结的回退件（legacy-snapshot.test.ts 锁 SHA-256），
//   且它的模块在 import 期会连带拉进 legacy 的 DOM 工具模块 —— 文本比对既无副作用，
//   也正好锁住「用户实际看到的那串字」。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 分区 → 按钮/前缀用的中文名。`venues.json` 的 `region` 是英文键，这里是它的官方中文名。 */
const REGION_PREFIX: Record<string, string> = {
  centum: "CENTUM 主场区",
  nampo: "南浦洞",
};

/** 从 `const <name>…= { … };` 里抽出 `key: "value",` 条目（两版 legend.ts 的对象字面量都是扁平的）。 */
function objectLiteral(source: string, name: string): Record<string, string> {
  const body = new RegExp(`${name}[^{]*\\{([\\s\\S]*?)\\n\\};`).exec(source);
  if (!body) throw new Error(`没在源码里找到 ${name} 对象字面量`);
  const entries: Record<string, string> = {};
  for (const line of body[1].split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+):\s*"([^"]*)",\s*$/.exec(line);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

const read = (path: string): string => readFileSync(path, "utf8");
const venues = (
  JSON.parse(read("public/venues.json")) as {
    venues: { group: string; region?: string }[];
  }
).venues;
const srcLegend = read("src/legend.ts");
const legacyLegend = read("legacy/src/legend.ts");
const srcArea = objectLiteral(srcLegend, "GROUP_AREA");
const legacyArea = objectLiteral(legacyLegend, "GROUP_AREA");

describe("影院分区口径：数据 ↔ 新版文案 ↔ 旧版文案", () => {
  it("本测试自带的前缀表与新版 REGION_LABEL 一致（否则期望值自己就会漂）", () => {
    expect(objectLiteral(srcLegend, "REGION_LABEL")).toEqual(REGION_PREFIX);
  });

  it("数据里每个 group 在两版 GROUP_AREA 里都有条目（缺了 tooltip 会渲染成「—」）", () => {
    for (const v of venues) {
      expect(srcArea[v.group], `新版缺 ${v.group}`).toBeTruthy();
      expect(legacyArea[v.group], `旧版缺 ${v.group}`).toBeTruthy();
    }
  });

  it("每个 group 的分区前缀 == venues.json 的 region（数据是唯一真源）", () => {
    for (const v of venues) {
      const prefix = REGION_PREFIX[v.region ?? ""] ?? `(未知 region: ${v.region})`;
      expect(srcArea[v.group].startsWith(prefix), `${v.group} 新版`).toBe(true);
      expect(legacyArea[v.group].startsWith(prefix), `${v.group} 旧版`).toBe(true);
    }
  });

  it("两个前端的同 group 文案逐字一致（口径漂移会被这条抓住）", () => {
    for (const v of venues) {
      expect(legacyArea[v.group], v.group).toBe(srcArea[v.group]);
    }
  });
});
