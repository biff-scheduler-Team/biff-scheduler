// 冲突检测口径测试。
//
// ⚠ 本文件同时**记录一个实测事实**(2026-09-11,PLAN-20260911000705):
//   `computeConflicts` 的 `transitFor` 入参**对结果零影响** —— 该函数实际是 **overlap-only**。
//   这是**刻意的**:红绿灯语义为「红 = 完全冲突(时间重叠)」(见 `style.css` / `grid.ts` 注释),
//   「跨馆余量不足(赶不上)」由 `grid.ts::markTight` 的**黄卡**(`bad = slack < 0`)覆盖,
//   行程页 `agenda.ts::gapConnector` 另有红色「⚠ 赶不上」。**没有漏报。**
//   → 结论:这是**死参数 + 与实现相左的文件头注释**(文档债),**不是行为 bug**。
//     **勿**改成让 transit 参与红色判定(只会把黄卡变红卡)。订正方向见 `PLAN.md` §7.5。
import { describe, expect, it } from "vitest";
import { computeConflicts, conflictGroupFor, type Slot } from "../src/conflict";

const slot = (code: string, start: number, end: number, venue = "b1", date = "2026-10-08"): Slot => ({
  code,
  date,
  start,
  end,
  venue,
});

describe("时间重叠 = 冲突(硬判据)", () => {
  it("同馆重叠 → 成对冲突,双方都进 codeSet", () => {
    const res = computeConflicts([slot("101", 600, 700), slot("102", 660, 760)], () => 0);
    const day = res.get("2026-10-08")!;
    expect(day.pairs).toEqual([["101", "102"]]);
    expect([...day.codeSet].sort()).toEqual(["101", "102"]);
  });

  it("首尾相接(end == next.start)不算冲突", () => {
    const day = computeConflicts([slot("101", 600, 700), slot("102", 700, 800)], () => 0).get("2026-10-08")!;
    expect(day.pairs).toHaveLength(0);
  });

  it("按日期隔离:不同天的场次永不冲突", () => {
    const res = computeConflicts(
      [slot("101", 600, 700, "b1", "2026-10-08"), slot("102", 600, 700, "b1", "2026-10-09")],
      () => 0
    );
    expect(res.get("2026-10-08")!.pairs).toHaveLength(0);
    expect(res.get("2026-10-09")!.pairs).toHaveLength(0);
  });

  it("pairs 里的 code 按字典序排序(与入参顺序无关)", () => {
    const day = computeConflicts([slot("202", 600, 700), slot("101", 660, 760)], () => 0).get("2026-10-08")!;
    expect(day.pairs).toEqual([["101", "202"]]);
  });

  it("三场连环重叠 → 两两成对", () => {
    const day = computeConflicts([slot("101", 600, 700), slot("102", 620, 720), slot("103", 640, 740)], () => 0).get(
      "2026-10-08"
    )!;
    expect(day.pairs).toEqual([
      ["101", "102"],
      ["101", "103"],
      ["102", "103"],
    ]);
  });
});

describe("★ 实测事实:transitFor 对结果零影响(函数是 overlap-only)", () => {
  // 文件头注释写的是「跨场馆时先结束的场次 end 追加 transit 再判重叠」,但实现里
  //   for (j…) { if (b.start >= a.end) break;  const transit = …; if (a.end + transit > b.start) … }
  // 那个 break 在**追加 transit 之前**就中断了内层循环;而在 guard `b.start < a.end` 之下,
  // `a.end + transit > b.start` 对任何 transit ≥ 0 **恒真** → transit 从不改变判定结果。
  // 这**符合**既定红绿灯语义(红 = 时间重叠);「跨馆赶不上」走 grid.ts::markTight 的黄卡,不是漏报。
  const crossVenueTight = [slot("101", 600, 700, "b1"), slot("102", 710, 770, "b2")]; // 余量 10min

  it("transit 传 0 与传 120 得到完全相同的冲突结果", () => {
    const a = computeConflicts(crossVenueTight, () => 0).get("2026-10-08")!;
    const b = computeConflicts(crossVenueTight, () => 120).get("2026-10-08")!;
    expect(b.pairs).toEqual(a.pairs);
    expect([...b.codeSet]).toEqual([...a.codeSet]);
    expect(a.pairs).toHaveLength(0); // ← 当前行为:转场不足但无重叠 → 不报冲突
  });

  it("只有「时间重叠」才会进 pairs —— 跨馆与否不影响", () => {
    const overlapSameVenue = computeConflicts([slot("101", 600, 700, "b1"), slot("102", 690, 780, "b1")], () => 0).get(
      "2026-10-08"
    )!;
    const overlapCrossVenue = computeConflicts([slot("101", 600, 700, "b1"), slot("102", 690, 780, "b2")], () => 999).get(
      "2026-10-08"
    )!;
    expect(overlapSameVenue.pairs).toHaveLength(1);
    expect(overlapCrossVenue.pairs).toHaveLength(1);
  });
});

describe("conflictGroupFor:取同一冲突组的全部 code", () => {
  it("未冲突的 code → undefined", () => {
    const day = computeConflicts([slot("101", 600, 700)], () => 0).get("2026-10-08")!;
    expect(conflictGroupFor(day, "101")).toBeUndefined();
  });

  it("冲突组 → 自身 + 与之成对的对方", () => {
    const day = computeConflicts([slot("101", 600, 700), slot("102", 620, 720), slot("103", 640, 740)], () => 0).get(
      "2026-10-08"
    )!;
    expect([...conflictGroupFor(day, "101")!].sort()).toEqual(["101", "102", "103"]);
    expect([...conflictGroupFor(day, "102")!].sort()).toEqual(["101", "102", "103"]);
  });

  it("result 为 undefined(该天无冲突)→ undefined", () => {
    expect(conflictGroupFor(undefined, "101")).toBeUndefined();
  });
});
