// 动作文案单一来源单测（2026-09-20,PLAN-20260920203010）。
//
// 两件事：
//   ① 语义 —— 各常量与构造函数产出预期的字符串（含「只有一场」副作用的说明、计数徽章措辞）；
//   ② **机械守卫** —— 全量扫描 `src/`，断言没有人再手写一遍这些措辞。
//      ② 才是这个文件的主要价值：措辞分散是当初那个「按钮太多了」的根因，
//      靠人记住「别写第二份」不管用，靠测试盯才管用（与 `scripts/check-repo.mjs` 同一思路）。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GO_SCHEDULE_LABEL,
  GO_VIEW_LABEL,
  SCHEDULED_STATE,
  SCHEDULE_LABEL,
  SOLE_SHOW_HINT,
  UNWANT_LABEL,
  UNSCHEDULE_LABEL,
  WANT_COUNT_SUFFIX,
  WANT_LABEL,
  WANT_TOAST,
  scheduleAria,
  soleShowToast,
  unwantAria,
  unwantConfirm,
  wantAria,
  wantCountLabel,
} from "../src/actions-copy";

const SRC = "src";
const COPY_FILE = join(SRC, "actions-copy.ts");

/** `src/` 下全部 .ts / .tsx（递归）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("两套动作的措辞", () => {
  it("影片级与场次级各自一对，且都有完成态", () => {
    expect(WANT_LABEL).toBe("想看");
    expect(UNWANT_LABEL).toBe("取消想看");
    expect(SCHEDULE_LABEL).toBe("排进行程");
    expect(UNSCHEDULE_LABEL).toBe("移出行程");
    expect(SCHEDULED_STATE).toBe("已排进行程");
  });

  it("无障碍名带上目标，且网格格子在给了片名时把片名也带上", () => {
    expect(wantAria("圣母玛利亚")).toBe("想看 圣母玛利亚");
    expect(unwantAria("圣母玛利亚")).toBe("取消想看 圣母玛利亚");
    expect(scheduleAria(false, "001")).toBe("排进行程 场次 001");
    expect(scheduleAria(true, "001")).toBe("移出行程 场次 001");
    // 网格格子没有可见文案，读屏只能靠 aria —— 多一个片名才好认
    expect(scheduleAria(false, "001", "圣母玛利亚")).toBe("排进行程 场次 001 圣母玛利亚");
    expect(scheduleAria(true, "001", "圣母玛利亚")).toBe("移出行程 场次 001 圣母玛利亚");
  });

  it("导航文案区别于动作文案（它们指向的是页面，不是动作）", () => {
    expect(GO_SCHEDULE_LABEL).not.toBe(SCHEDULE_LABEL);
    expect(GO_VIEW_LABEL).not.toBe(GO_SCHEDULE_LABEL);
  });
});

describe("只有一场的副作用说明", () => {
  it("提示里点名了按钮文案，用户能对上" , () => {
    expect(SOLE_SHOW_HINT).toContain(WANT_LABEL);
    expect(SOLE_SHOW_HINT).toContain("只有这一场");
    expect(soleShowToast("蓦然回首")).toContain("只有一场");
    expect(soleShowToast("蓦然回首")).toContain("已直接排进行程");
  });
});

describe("取消想看的确认框", () => {
  it("已排场次时必须说清会连带移除这些场次", () => {
    expect(unwantConfirm("彼此的日夜", 3)).toContain("3 场");
    expect(unwantConfirm("彼此的日夜", 3)).toContain(UNWANT_LABEL);
  });

  it("只是选片、没排场时不提「已排」", () => {
    const text = unwantConfirm("彼此的日夜", 0);
    expect(text).toContain(UNWANT_LABEL);
    expect(text).not.toContain("已排");
  });
});

describe("计数徽章不再与按钮撞名", () => {
  it("徽章说的是「别人多少人在想看」，不是动作", () => {
    expect(WANT_COUNT_SUFFIX).toBe("人想看");
    expect(wantCountLabel(12)).toBe("12 人想看");
    // ⚠ 关键：徽章文案**不能**等于按钮文案，否则「想看 12」会被读成「点这里会变成 12」
    expect(wantCountLabel(12)).not.toBe(WANT_LABEL);
    expect(wantCountLabel(12).startsWith(WANT_LABEL)).toBe(false);
  });

  it("成功提示也走单一来源", () => {
    expect(WANT_TOAST).toContain(WANT_LABEL);
  });
});

describe("机械守卫：没有第二份措辞", () => {
  // ⚠ 只挡**带引号的字面量**。注释里写「原先叫加入行程」是历史说明，不该被本测试判死
  //   （本仓库注释一律用「」，正好与 JS 字符串字面量的直引号区分开）。
  const BANNED_LITERALS = [
    '"加入行程"',
    '"移出行程"',
    '"移除影片"',
    '"加入我的选片"',
    '"已加入行程"',
    '"移出"',
    '"加入"',
    '"想看"',
    '"取消想看"',
    '"排进行程"',
  ];

  it("旧措辞不再作为字面量出现在任何组件里", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (path === COPY_FILE) continue;
      const text = readFileSync(path, "utf8");
      for (const banned of BANNED_LITERALS) {
        if (text.includes(banned)) offenders.push(`${path} 含 ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("新措辞的字面量只许出现在 actions-copy.ts 一处", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (path === COPY_FILE) continue;
      const text = readFileSync(path, "utf8");
      for (const label of [WANT_LABEL, UNWANT_LABEL, SCHEDULE_LABEL, UNSCHEDULE_LABEL]) {
        if (text.includes(`"${label}"`)) offenders.push(`${path} 手写了「${label}」`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
