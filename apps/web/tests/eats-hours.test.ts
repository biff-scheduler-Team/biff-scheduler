// 「吃喝」页的营业状态判定(2026-10-05,`PLAN-20261005205733`)。
//
// 用例里的 `hours` 全部**逐字抄自 `public/eats.json`** —— 解析器是给这份自由文本写的,
// 拿自造的规整串测等于没测。时刻一律用釜山时间字面量写,读的人不用自己算偏移。
// ⚠ 只测纯函数,不碰 DOM(单测跑在 node 环境)。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openStateAt } from "../src/eats-hours";

/** 釜山时间字面量 → `Date`。 */
function kst(local: string): Date {
  return new Date(`${local}+09:00`);
}

// 2026-10-05 是周一,所以:10-06 周二 / 10-09 周五 / 10-10 周六 / 10-11 周日
const TUE = "2026-10-06";
const FRI = "2026-10-09";
const SAT = "2026-10-10";
const SUN = "2026-10-11";

describe("24 小时与跨午夜", () => {
  it("`24小时营业` 任何时刻都算开着", () => {
    expect(openStateAt("24小时营业", kst(`${TUE}T03:00:00`))).toBe("open");
    expect(openStateAt("24小时营业", kst(`${TUE}T23:30:00`))).toBe("open");
  });

  it("`17:30-2:30` 的营业日**从开始那天算**:凌晨 1 点属于前一天的窗口", () => {
    expect(openStateAt("17:30-2:30", kst(`${TUE}T18:00:00`))).toBe("open");
    expect(openStateAt("17:30-2:30", kst(`${TUE}T12:00:00`))).toBe("closed");
    // 周二 17:30 → 周三 02:30:周三凌晨还在窗口里
    expect(openStateAt("17:30-2:30", kst("2026-10-07T01:00:00"))).toBe("open");
    expect(openStateAt("17:30-2:30", kst("2026-10-07T03:00:00"))).toBe("closed");
  });

  it("`11:00-4:00` 同样跨午夜", () => {
    expect(openStateAt("11:00-4:00", kst("2026-10-07T02:00:00"))).toBe("open");
    expect(openStateAt("11:00-4:00", kst("2026-10-07T05:00:00"))).toBe("closed");
  });

  it("`07:30-24:00` 到当天 24 点收 —— 24:00 不是跨午夜", () => {
    const hours = "07:30-24:00 · 13:00-15:00休息";
    expect(openStateAt(hours, kst(`${TUE}T23:00:00`))).toBe("open");
    expect(openStateAt(hours, kst("2026-10-07T01:00:00"))).toBe("closed");
  });
});

describe("午休窗口", () => {
  const hours = "11:00-21:00 · 15:00-17:00休息 · 20:00LAST ORDER";

  it("午休期间算打烊,两头算营业", () => {
    expect(openStateAt(hours, kst(`${TUE}T14:00:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${TUE}T16:00:00`))).toBe("closed");
    expect(openStateAt(hours, kst(`${TUE}T19:00:00`))).toBe("open");
  });

  it("`LAST ORDER` 不是闭店时刻 —— 20:00 之后仍在营业窗口里", () => {
    expect(openStateAt(hours, kst(`${TUE}T20:30:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${TUE}T21:30:00`))).toBe("closed");
  });

  it("结束时刻是**开区间** —— 21:00 整已经打烊", () => {
    expect(openStateAt("11:00-21:00", kst(`${TUE}T20:59:00`))).toBe("open");
    expect(openStateAt("11:00-21:00", kst(`${TUE}T21:00:00`))).toBe("closed");
  });
});

describe("星期限定", () => {
  it("`周二-周日11:00-21:00` 在周一不营业", () => {
    expect(openStateAt("周二-周日11:00-21:00", kst(`${TUE}T12:00:00`))).toBe("open");
    expect(openStateAt("周二-周日11:00-21:00", kst("2026-10-05T12:00:00"))).toBe("closed");
  });

  it("`周一-周六 08:00-21:30` 在周日不营业", () => {
    expect(openStateAt("周一-周六 08:00-21:30", kst(`${SAT}T12:00:00`))).toBe("open");
    expect(openStateAt("周一-周六 08:00-21:30", kst(`${SUN}T12:00:00`))).toBe("closed");
  });

  it("`周一到周五11:00-18:30 14:50 -16:00休息` 的星期限定与午休互不干扰", () => {
    const hours = "周一到周五11:00-18:30 14:50 -16:00休息";
    expect(openStateAt(hours, kst(`${TUE}T12:00:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${TUE}T15:00:00`))).toBe("closed");
    expect(openStateAt(hours, kst(`${SAT}T12:00:00`))).toBe("closed");
  });
});

describe("整日闭店条款", () => {
  it("括号里的 `周日休息`", () => {
    const hours = "10:00-19:00（周日休息）";
    expect(openStateAt(hours, kst(`${TUE}T12:00:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${SUN}T12:00:00`))).toBe("closed");
  });

  it("`周五周六休息` 连着写两天", () => {
    const hours = "8:00-21:30 · （周五周六休息）";
    expect(openStateAt(hours, kst(`${TUE}T12:00:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${FRI}T12:00:00`))).toBe("closed");
    expect(openStateAt(hours, kst(`${SAT}T12:00:00`))).toBe("closed");
  });

  it("`（10/6休息）` 只挡那一天,不影响别的日子", () => {
    const hours = "12:00-23:00（10/6休息）";
    expect(openStateAt(hours, kst("2026-10-06T12:00:00"))).toBe("closed");
    expect(openStateAt(hours, kst("2026-10-07T12:00:00"))).toBe("open");
  });

  it("定日闭店优先于 `24小时营业`", () => {
    expect(openStateAt("24小时营业（10/6休息）", kst("2026-10-06T12:00:00"))).toBe("closed");
  });
});

describe("一天内两段日程", () => {
  const hours = "周一到周五08:00-19:00 · 周末09:00 ~ 19:00";

  it("工作日走第一段(08:00 就开),周末走第二段(09:00 才开)", () => {
    expect(openStateAt(hours, kst(`${TUE}T08:30:00`))).toBe("open");
    // 阴性对照:同一时刻在周六还没开门
    expect(openStateAt(hours, kst(`${SAT}T08:30:00`))).toBe("closed");
    expect(openStateAt(hours, kst(`${SAT}T10:00:00`))).toBe("open");
    expect(openStateAt(hours, kst(`${SUN}T22:00:00`))).toBe("closed");
  });
});

describe("认不出来时保守回 unknown —— 宁可不显示,也不编一个「营业中」", () => {
  it("空串与纯文字说明", () => {
    expect(openStateAt("", kst(`${TUE}T12:00:00`))).toBe("unknown");
    expect(openStateAt("详见店内", kst(`${TUE}T12:00:00`))).toBe("unknown");
  });

  it("含「节假日」的条款在工作日无法下结论 —— 韩国公休日没法离线枚举", () => {
    const hours = "周一到周五11:00-18:30 14:50 -16:00休息 · 周末节假日休息";
    expect(openStateAt(hours, kst(`${TUE}T12:00:00`))).toBe("unknown");
    // 星期六由「周末休息」直接挡掉,不需要知道公休日
    expect(openStateAt(hours, kst(`${SAT}T12:00:00`))).toBe("closed");
  });

  it("`unknown` 绝不等于「开着」—— 只有 `open` 才是确定营业中", () => {
    expect(openStateAt("", kst(`${TUE}T12:00:00`))).not.toBe("open");
  });
});

describe("时区基准是釜山(UTC+9),不是浏览器所在时区", () => {
  it("同一个绝对时刻,用 UTC 字面量写也得到同一结论", () => {
    // 2026-10-06T03:00:00Z = 釜山 12:00
    expect(openStateAt("11:00-21:00", new Date("2026-10-06T03:00:00Z"))).toBe("open");
    // 2026-10-06T12:00:00Z = 釜山 21:00 → 已打烊
    expect(openStateAt("11:00-21:00", new Date("2026-10-06T12:00:00Z"))).toBe("closed");
    // 跨午夜窗口:釜山周三 01:00 = UTC 周二 16:00
    expect(openStateAt("17:30-2:30", new Date("2026-10-06T16:00:00Z"))).toBe("open");
  });
});

describe("真实清单", () => {
  const file = JSON.parse(readFileSync("public/eats.json", "utf8")) as {
    shops: { id: string; hours: string }[];
  };

  it("每一条 hours 都能给出三态之一(解析器不抛异常、不返回空)", () => {
    const states = file.shops.map((shop) => openStateAt(shop.hours, kst(`${TUE}T12:00:00`)));
    for (const state of states) expect(["open", "closed", "unknown"]).toContain(state);
    // 没写营业时间的那批(Naver 收藏夹)必须是 unknown,不能被当成开着
    const blank = file.shops.filter((shop) => !shop.hours);
    expect(blank.length).toBeGreaterThan(0);
    for (const shop of blank) expect(openStateAt(shop.hours, kst(`${TUE}T12:00:00`))).toBe("unknown");
  });

  it("写了营业时间的店里,认不出来的至多 1 家(`周末节假日休息` 那家)—— 多一家就说明解析器退化了", () => {
    const unknown = file.shops
      .filter((shop) => shop.hours)
      .filter((shop) => openStateAt(shop.hours, kst(`${TUE}T12:00:00`)) === "unknown");
    expect(unknown.map((shop) => shop.id)).toEqual(["kr-eedcbd4a"]);
  });

  it("周二中午至少有一批店判定为营业中 —— 全 closed 同样是退化", () => {
    const open = file.shops.filter((shop) => openStateAt(shop.hours, kst(`${TUE}T12:00:00`)) === "open");
    expect(open.length).toBeGreaterThan(10);
  });
});
