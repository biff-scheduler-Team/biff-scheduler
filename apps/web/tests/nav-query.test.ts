// 导航查询串口径(`app/nav-query.ts`)的回归哨兵 —— 2026-09-17
// (`PLAN-20260917002528`)。
//
// 为什么单测它:用户报「在影片库搜 Midnight Passion,切到吃喝的搜索框里也有」——
// 根因不是吃喝读错了 key,而是主导航把**整条 search 原样**搬到了每个链接上,
// 而 `q` 在影片库 / 红黑榜 / 吃喝三页各有一份语义(片名 / 榜单片名 / 店名)。
// 这条测试钉死「同名 key 不跨页,只有 date / hour 跟着走」。

import { describe, expect, it } from "vitest";
import { navSearch } from "../src/app/nav-query";

describe("navSearch:同名 key 不跨页", () => {
  it("影片库的搜索词不会跟到吃喝(原 bug 的最小复现)", () => {
    // 修复前:导航链接是 `${path}${pageSearch}`,吃喝的 searchbox 会读到 Midnight Passion
    expect(navSearch("?q=Midnight+Passion", "/library", "/eats")).toBe("");
  });

  it("反向同样不串:吃喝的店名不会跟到影片库", () => {
    expect(navSearch("?q=%EC%98%A4%EC%84%A4%EB%A1%9D", "/eats", "/library")).toBe("");
  });

  it("吃喝三个参数只在吃喝内部成立,一个都不外流", () => {
    const search = "?q=x&district=east&menu=%ED%95%9C%EC%8B%9D";
    expect(navSearch(search, "/eats", "/library")).toBe("");
    expect(navSearch(search, "/eats", "/eats")).toBe(search);
  });

  it("排片表的定位请求(focus / focusDate / locate)不外流到别的页", () => {
    const search = "?date=2026-10-07&hour=9&focus=008&focusDate=2026-10-07&locate=abc";
    expect(navSearch(search, "/schedule", "/library")).toBe("?date=2026-10-07&hour=9");
  });

  it("排片表的 focus 不外流到别的页,同页导航才保留", () => {
    // ⚠ 原用例拿「讨论区」当对照页(`/discussions` 与排片表各有一份 `focus` 语义);
    //   讨论区已于 2026-09-22 下线(`PLAN-20260922101227`),改用仍存在的两页做同一断言。
    expect(navSearch("?focus=008", "/schedule", "/library")).toBe("");
    expect(navSearch("?q=abc", "/library", "/schedule")).toBe("");
    expect(navSearch("?focus=008", "/schedule", "/schedule")).toBe("?focus=008");
  });
});

describe("navSearch:跨页保留项与同页参数", () => {
  it("date / hour 跨页保留(切回排片表还是那一天那个时段)", () => {
    expect(navSearch("?date=2026-10-07&hour=9", "/schedule", "/library"))
      .toBe("?date=2026-10-07&hour=9");
    expect(navSearch("?date=2026-10-07", "/schedule", "/picks")).toBe("?date=2026-10-07");
  });

  it("同页导航保留该页全部私有参数(浮动面板「打开完整页面」)", () => {
    expect(navSearch("?pickDate=2026-10-07,2026-10-08&expand=f1&date=2026-10-07", "/picks", "/picks"))
      .toBe("?pickDate=2026-10-07%2C2026-10-08&expand=f1&date=2026-10-07");
  });

  it("影片资料弹层算宿主页(在弹层里回宿主页不算跨页)", () => {
    expect(navSearch("?unit=midnight", "/library/films/f1", "/library")).toBe("?unit=midnight");
    expect(navSearch("?unit=midnight", "/library/films/f1", "/eats")).toBe("");
  });

  it("quick(浮动面板开关)一律由调用方自己加回来", () => {
    expect(navSearch("?quick=1&date=2026-10-07", "/picks", "/schedule")).toBe("?date=2026-10-07");
    expect(navSearch("?quick=1&pickDate=2026-10-07", "/picks", "/picks")).toBe("?pickDate=2026-10-07");
  });

  it("无参数时返回空串(不是裸 `?`)", () => {
    expect(navSearch("", "/schedule", "/schedule")).toBe("");
    expect(navSearch("?q=x", "/library", "/schedule")).toBe("");
  });
});
