// 回归测试:发版后「新版接管本页」必须被认出来,而**首次安装的那次 claim 不能被误认成新版**。
//
// 原症状(2026-09-22,PLAN-20260922100704):线上 `registerSW.js` 只注册 SW,没有「新版接管后刷新」;
// workbox 又把 `index.html` 带 revision 预缓存了,导航请求直接吃缓存 ——
// 于是发版后首次打开仍是旧版、一直开着的标签页永远等不到新版,用户只能 Ctrl+Shift+R。
//
// 这里只测判定逻辑本身(纯函数),DOM 侧的接线由 `e2e/react/pwa-update.spec.ts` 覆盖。

import { describe, expect, it } from "vitest";
import {
  createOnceGuard,
  createThrottle,
  createUpdateDetector,
  type UpdateWatchTarget,
} from "../src/pwa-update";

/** 假 SW 容器:只提供检测需要的那一个成员,并记下 `controllerchange` 的订阅者。 */
function fakeTarget(controlled: boolean) {
  const listeners = new Set<() => void>();
  const target: UpdateWatchTarget = {
    controlled,
    watchControllerChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    target,
    /** 模拟一次 `controllerchange`(可能同时通知多个订阅者,和真实事件一样)。 */
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    watching: () => listeners.size,
  };
}

describe("createUpdateDetector", () => {
  it("加载时还没有 controller(首次访问),装机那次 claim 不算新版", () => {
    const { target, fire } = fakeTarget(false);
    const detector = createUpdateDetector(target);
    const notified: number[] = [];
    detector.subscribe(() => notified.push(1));

    fire();

    expect(detector.available).toBe(false);
    expect(notified).toEqual([]);
  });

  it("加载时已被 SW 控制,再来一次 controllerchange 就是新版", () => {
    const { target, fire } = fakeTarget(true);
    const detector = createUpdateDetector(target);
    const notified: number[] = [];
    detector.subscribe(() => notified.push(1));

    fire();

    expect(detector.available).toBe(true);
    expect(notified).toEqual([1]);
  });

  it("首次 claim 之后的第二次 controllerchange 才算新版(补上前一个用例的另一半)", () => {
    const { target, fire } = fakeTarget(false);
    const detector = createUpdateDetector(target);

    fire(); // 装机 claim —— 不提示
    expect(detector.available).toBe(false);

    fire(); // 之后换了一版 —— 提示
    expect(detector.available).toBe(true);
  });

  it("重复的 controllerchange 只置位、只通知一次", () => {
    const { target, fire } = fakeTarget(true);
    const detector = createUpdateDetector(target);
    const notified: number[] = [];
    detector.subscribe(() => notified.push(1));

    fire();
    fire();
    fire();

    expect(notified).toEqual([1]);
  });

  it("退订之后不再收到通知", () => {
    const { target, fire } = fakeTarget(true);
    const detector = createUpdateDetector(target);
    const notified: number[] = [];
    const detach = detector.subscribe(() => notified.push(1));

    detach();
    fire();

    expect(detector.available).toBe(true);
    expect(notified).toEqual([]);
  });

  it("dispose 会摘掉对 SW 事件的监听", () => {
    const { target, fire, watching } = fakeTarget(true);
    const detector = createUpdateDetector(target);
    expect(watching()).toBe(1);

    detector.dispose();
    fire();

    expect(watching()).toBe(0);
    expect(detector.available).toBe(false);
  });
});

describe("createThrottle", () => {
  it("第一次调用必须放行(否则首个「切回前台」会被自己的闸门吃掉)", () => {
    const clock = 1_000;
    const allowed = createThrottle(100, () => clock);

    expect(allowed()).toBe(true);
  });

  it("间隔内的重复调用被拒,到点后再次放行", () => {
    let clock = 1_000;
    const allowed = createThrottle(100, () => clock);

    expect(allowed()).toBe(true);
    clock = 1_099;
    expect(allowed()).toBe(false);
    clock = 1_100;
    expect(allowed()).toBe(true);
  });
});

describe("createOnceGuard", () => {
  it("只放行一次 —— 「刷新」连点不会 reload 多次", () => {
    const guard = createOnceGuard();

    expect(guard()).toBe(true);
    expect(guard()).toBe(false);
    expect(guard()).toBe(false);
  });
});
