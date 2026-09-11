// GV 映后谈口径测试 —— 「有效结束」是网格 / 冲突 / 紧转场 / 行程 / 质量分 / .ics 的共同输入,
// 一处算错就会全链路一起错(改全局时长却不改结束时间,配置就是假的)。见 `gv.ts` 文件头。
import { beforeEach, describe, expect, it } from "vitest";
import { effEndHms, effEndMin, filmEndMin, gvTalkMin, resolveTalk, talkOnOf } from "../src/gv";
import { gvTalk, gvTalkMinOv, store } from "../src/state";
import { hmsToMin } from "../src/util";
import { show } from "./helpers";

beforeEach(() => {
  // 每个用例从干净的默认态开始(store 是模块级单例,不重置会互相污染)
  store.settings.gvTalkMin = 25;
  store.settings.gvTalkOn = true;
  gvTalkMinOv.clear();
  gvTalk.clear();
});

describe("gvTalkMin:单场覆写 ?? 全局默认;非 GV 恒 0", () => {
  it("非 GV 场次恒 0(即便挂了覆写)", () => {
    gvTalkMinOv.set("101", 40);
    expect(gvTalkMin(show({ code: "101", is_gv: false }))).toBe(0);
  });

  it("GV 场缺省用全局默认", () => {
    expect(gvTalkMin(show({ code: "101", is_gv: true }))).toBe(25);
  });

  it("GV 场:单场覆写优先于全局", () => {
    store.settings.gvTalkMin = 30;
    gvTalkMinOv.set("101", 10);
    expect(gvTalkMin(show({ code: "101", is_gv: true }))).toBe(10);
  });

  it("钳制:负数 → 0,超上限(24h)→ 1440,小数四舍五入", () => {
    gvTalkMinOv.set("a", -5);
    gvTalkMinOv.set("b", 99999);
    gvTalkMinOv.set("c", 12.6);
    expect(gvTalkMin(show({ code: "a", is_gv: true }))).toBe(0);
    expect(gvTalkMin(show({ code: "b", is_gv: true }))).toBe(1440);
    expect(gvTalkMin(show({ code: "c", is_gv: true }))).toBe(13);
  });

  it("NaN 覆写视为 0(不让 NaN 传染后续算术)", () => {
    gvTalkMinOv.set("n", Number.NaN);
    expect(gvTalkMin(show({ code: "n", is_gv: true }))).toBe(0);
  });
});

describe("effEndMin:有效结束", () => {
  // 20:00 开场 / 片长 100 → 正片末 21:40;官方槽位末 22:05(= 21:40 + 25min 谈)
  const gv = show({ code: "101", is_gv: true, start_time: "20:00", end_time: "22:05", duration_min: 100 });

  it("有谈段 + 参加 → 正片末 + 时长(不取官方 end_time)", () => {
    expect(filmEndMin(gv)).toBe(21 * 60 + 40);
    expect(effEndMin(gv, true)).toBe(21 * 60 + 40 + 25);
    expect(effEndHms(gv, true)).toBe("22:05");
  });

  it("有谈段 + 放弃 → 正片末(映后谈不占时间)", () => {
    expect(effEndMin(gv, false)).toBe(21 * 60 + 40);
    expect(effEndHms(gv, false)).toBe("21:40");
  });

  it("★ 改全局时长会真的改变结束时间(否则「可配置」是假的)", () => {
    store.settings.gvTalkMin = 40;
    expect(effEndMin(gv, true)).toBe(21 * 60 + 40 + 40);
    expect(effEndHms(gv, true)).toBe("22:20");
  });

  it("谈段时长为 0 → 退回官方 end_time(不拆映后段)", () => {
    store.settings.gvTalkMin = 0;
    expect(effEndMin(gv, true)).toBe(hmsToMin("22:05"));
    expect(effEndMin(gv, false)).toBe(hmsToMin("22:05"));
  });

  it("★ 无谈段(非 GV)→ 取官方 end_time:保护性分支", () => {
    // 槽位 10:00–11:40 但片长只有 90min(2025 实测有 6 场片长 ≠ 槽位)
    // → 若一律改走 start + duration,会静默改变这 6 场的冲突判定
    const odd = show({ code: "201", is_gv: false, start_time: "10:00", end_time: "11:40", duration_min: 90 });
    expect(effEndMin(odd, true)).toBe(hmsToMin("11:40"));
    expect(effEndMin(odd, false)).toBe(hmsToMin("11:40"));
    expect(filmEndMin(odd)).toBe(hmsToMin("11:30")); // 正片末另算,但不用作有效结束
  });

  it("跨午夜:正片末 + 谈段可越过 24:00,全程不取模", () => {
    const mid = show({ code: "301", is_gv: true, start_time: "23:30", end_time: "25:55", duration_min: 120 });
    expect(filmEndMin(mid)).toBe(25 * 60 + 30); // 23:30 + 120 = 次日 01:30
    expect(effEndMin(mid, true)).toBe(25 * 60 + 55);
    expect(effEndHms(mid, true)).toBe("25:55"); // 保留 24+ 供 ICS Date.UTC 自动进位
    expect(effEndHms(mid, false)).toBe("25:30");
  });
});

describe("resolveTalk / talkOnOf:三态解析(单场覆写 ?? 全局默认)", () => {
  it("resolveTalk 覆写优先,undefined 才跟随全局", () => {
    expect(resolveTalk(undefined, true)).toBe(true);
    expect(resolveTalk(undefined, false)).toBe(false);
    expect(resolveTalk(false, true)).toBe(false);
    expect(resolveTalk(true, false)).toBe(true);
  });

  it("talkOnOf 读 store.gvTalk ?? store.settings.gvTalkOn", () => {
    expect(talkOnOf("101")).toBe(true);
    gvTalk.set("101", false);
    expect(talkOnOf("101")).toBe(false);
    store.settings.gvTalkOn = false;
    expect(talkOnOf("202")).toBe(false); // 无覆写 → 跟随全局
  });
});
