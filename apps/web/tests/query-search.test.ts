// 回归测试:搜索框必须能**连续输入中文**(`PLAN-20260917112233`)。
//
// 原 bug:影片库 / 吃喝 / 红黑榜三个搜索框把 `SearchField` 的 `value` 直接绑在 URL 上
// (`value={params.get("q") ?? ""}`),而 `onChange` 里的 `setSearchParams` 是一次
// **router 导航(异步)** —— 受控 input 的显示值于是永远慢一拍。
// 中文输入法是**组合态**:拼音串暂存在 input 的 DOM 里,此刻 `input.value !== props.value`;
// React 每次提交都把 props.value 回写进 DOM,慢的这一拍正好把组合中的拼音串擦掉,
// 于是「能打英文、打不了中文」(英文逐字符即时提交,回写值等于刚敲的字符,看不出问题)。
//
// 这条测试钉死修复后的三条不变量:
//   ① 输入不立刻写 URL(延迟合并),否则每个拼音字母都触发一次导航;
//   ② 组合态**一律不写**(拼音串是中间态,不是用户要搜的词);
//   ③ URL 反过来只在「不是本地刚提交出去的那次回声」时才回写输入框,
//      否则提交后的 URL 回声会把用户**正在进行中**的输入打断 —— 这正是原 bug 的机制。
//
// 被测模块是纯逻辑(node 环境即可,不碰 DOM),定时器用 vitest 的假时钟驱动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_COMMIT_DELAY_MS, createQueryCommitter } from "../src/app/query-search";

describe("createQueryCommitter:延迟提交", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("输入后不立刻写 URL,等满一个延迟才写一次", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    committer.type("电影", false);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS - 1);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(written).toEqual(["电影"]);
  });

  it("连续输入只在停顿后写最后一次(不是每个字母一次导航)", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    for (const value of ["d", "di", "dia", "dian"]) {
      committer.type(value, false);
      vi.advanceTimersByTime(50);
    }
    expect(written).toEqual([]);

    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);
    expect(written).toEqual(["dian"]);
  });

  it("值没变时不重复写(避免一次无谓的导航)", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    committer.type("电影", false);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);
    expect(written).toEqual(["电影"]);

    committer.type("电影", false);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);
    expect(written).toEqual(["电影"]);
  });
});

describe("createQueryCommitter:组合态闸门", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("输入法组合期间绝不动 URL —— 拼音串不该被当成搜索词", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    // 用户正在拼「电影」,react-aria 每个字母都给一次 onChange
    committer.type("d", true);
    committer.type("di", true);
    committer.type("dian", true);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS * 5);
    expect(written).toEqual([]);
  });

  it("组合结束才提交,提交的是**上屏后**的值而不是拼音串", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    committer.type("dian", true);
    committer.composeEnd("电影");

    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);
    expect(written).toEqual(["电影"]);
  });

  it("组合期间挂起的旧提交被取消,不会写出一条过期的中间态", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    committer.type("abc", false);
    // 还没到延迟,用户接着开始打拼音
    vi.advanceTimersByTime(50);
    committer.type("a", true);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS * 3);
    expect(written).toEqual([]);
  });
});

describe("createQueryCommitter:回声判定", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("本地刚提交出去的值算回声(调用方不要拿它回写输入框)", () => {
    const committer = createQueryCommitter(() => {});

    committer.type("电影", false);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);

    expect(committer.isEcho("电影")).toBe(true);
  });

  it("外部导航改出来的值不算回声(要回写输入框 —— 分享链接进来得能看到搜索词)", () => {
    const committer = createQueryCommitter(() => {});

    committer.type("电影", false);
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS);

    expect(committer.isEcho("别的词")).toBe(false);
    expect(committer.isEcho("")).toBe(false);
  });

  it("从没提交过时任何 URL 值都不算回声", () => {
    const committer = createQueryCommitter(() => {});
    expect(committer.isEcho("")).toBe(false);
    expect(committer.isEcho("电影")).toBe(false);
  });
});

describe("createQueryCommitter:卸载清理", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispose 之后挂起的提交不再落地(组件已卸载,不该再导航)", () => {
    const written: string[] = [];
    const committer = createQueryCommitter((value) => written.push(value));

    committer.type("电影", false);
    committer.dispose();
    vi.advanceTimersByTime(SEARCH_COMMIT_DELAY_MS * 3);
    expect(written).toEqual([]);
  });
});
