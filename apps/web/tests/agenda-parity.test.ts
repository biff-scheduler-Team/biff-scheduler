import { describe, expect, it } from "vitest";
import { topPlanCodes } from "../src/app/agenda-model";
import { computeConflicts } from "../src/conflict";
import { buildPlanSet } from "../src/plans";

describe("当前行程的取值口径", () => {
  // 「导出范围 = 当前行程」走 `topPlanCodes`(唯一调用方是 `ExportDialog`)。
  // 顺位下线后组内次序 = 开场时间,同刻再按 code 字典序 —— 所以「每组取哪一场」是可预期的。
  it("topPlanCodes = 共同场次 + 每个冲突组的第一场", () => {
    const groups = [["008", "033"], ["143", "080"]];
    const slots = groups.flatMap((group, i) =>
      group.map((code) => ({
        code,
        date: `2026-10-0${i + 7}`,
        start: 600,
        end: 720,
        venue: "b1",
      })),
    );
    const plans = buildPlanSet(
      groups.flat(),
      computeConflicts(slots, () => 0),
      // 组内排序键统一 → 回落 code 字典序(store 里传的是开场时刻)
      () => 0,
      () => null,
    );
    expect(plans.groups).toEqual([
      ["008", "033"],
      ["080", "143"],
    ]);
    expect(topPlanCodes(plans)).toEqual(["008", "080"]);
  });

  it("共同场次原样并进结果,且排在冲突组取值之前", () => {
    const plans = buildPlanSet(
      ["a", "b", "c"],
      computeConflicts(
        [
          { code: "a", date: "2026-10-07", start: 600, end: 700, venue: "b1" },
          { code: "b", date: "2026-10-07", start: 650, end: 750, venue: "b1" },
          { code: "c", date: "2026-10-08", start: 600, end: 700, venue: "b1" },
        ],
        () => 0,
      ),
      () => 0,
      () => null,
    );
    expect(plans.common).toEqual(["c"]);
    expect(topPlanCodes(plans)).toEqual(["c", "a"]);
  });
});

/* `rankSpotOrder()` 与 `agendaItems()` 的用例已于 2026-09-30 一并删除
 * (`PLAN-20260930213528`):前者服务的顺位撞车让路、后者服务的卡片视图按日条目拼装,
 * 两套机制都已整体下线。 */
