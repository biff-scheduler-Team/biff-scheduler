import type { PlanSet } from "../plans";

/** 「当前行程」的**真值**:共同场次 + 每个冲突组的第一场(组内按开场时间排好,故第 1 场即最早)。
 *  ⚠ 名字里的 plan 是历史包袱(2026-09-22 之前它同时是「保存方案」的取值口径,`PLAN-20260922105228`)——
 *  方案整体下线后它**只剩一个调用方**:`ExportDialog` 的「导出范围 = 当前行程」。别再往它身上挂新语义。 */
export function topPlanCodes(plans: Pick<PlanSet, "common" | "groups">): string[] {
  return [...plans.common, ...plans.groups.map((group) => group[0])];
}

/* `rankSpotOrder()` / `AgendaItem` / `agendaItems()` 已于 2026-09-30 删除
 * (`PLAN-20260930213528`):前者是「顺位撞车的逐组让路」,后两者是**卡片视图**的按日条目拼装
 * (顺位卡 / 间隔提示 / 按日折叠)—— 顺位机制与卡片视图都已整体下线,本文件只剩上面那一支。
 * ⚠ 冲突组本身没有消失:`plans.ts::groups` 仍按 `topPlanCodes` 供导出范围取值。 */
