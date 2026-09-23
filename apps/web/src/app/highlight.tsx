/**
 * 悬停高亮 —— 模块级外部 store（2026-09-23，PLAN-20260923111748，B5）。
 *
 * ★ 为什么不是 Context + useState：
 *   `setCode` 改 Context value 会让**所有消费者重渲染**（Provider 的 value 还是每次渲染新建的对象）。
 *   而甘特图每个 slot、场次卡每张卡在 render 里都要跑 `filmInfoOf` / `doubaoScoreOf` /
 *   `cardStateOf` / `screeningMembers` —— 于是「鼠标划过网格」变成连续多次全届级重计算。
 *   改成外部 store 后：hover 只写这里，**画布在订阅回调里直接改 DOM**（`data-highlighted`，
 *   与 `RedBlackPage::setHover` 同一做法），React 一次都不重渲染；
 *   需要「当前高亮哪一场」的 React 组件用 `useHighlightedCode()` 订阅，只重渲染自己那棵小树。
 *
 * ⚠ 「哪几场要一起亮」仍是**同一处口径**：`highlightCodesFor(cat, conflicts, code)`
 *   （纯函数，可单测）—— 别在看板/行程里各写一遍冲突组展开。
 */

import { useSyncExternalStore } from "react";
import { conflictGroupFor } from "../conflict";
import type { ConflictResult } from "../conflict";
import type { Catalog } from "../types";

const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let current: string | null = null;

/** 当前高亮的那一场（`null` = 没有）。 */
export function highlightedCode(): string | null {
  return current;
}

/** 写高亮。同值不通知（hover 在同格内反复触发不该产生任何工作）。 */
export function setHighlight(code: string | null): void {
  const next = code && code.length > 0 ? code : null;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** 订阅高亮变化（画布用它做 DOM 直改）。返回退订函数。 */
export function subscribeHighlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 「高亮这场时要一起亮的场次集合」—— 冲突组优先，无冲突就是它自己。
 *
 *  ⚠ 带一层 WeakMap 缓存：`conflictGroupFor` 每次调用都会重建整张邻接表（`conflict.ts::adjacencyOf`
 *    没有缓存），而场次卡是**每张卡**都要问一次「我在不在高亮组里」—— 不缓存的话，
 *    hover 一次的代价是「卡片数 × 冲突对数」。键用 `ConflictResult` 的对象标识：
 *    `conflicts` 由 `store.tsx::derive` 在 store 版本变化时整体重建，故缓存天然随之失效。 */
const groupCache = new WeakMap<ConflictResult, Map<string, ReadonlySet<string>>>();

export function highlightCodesFor(
  cat: Catalog,
  conflicts: ReadonlyMap<string, ConflictResult>,
  code: string | null,
): ReadonlySet<string> {
  if (!code) return EMPTY;
  const screening = cat.byCode.get(code);
  if (!screening) return new Set([code]);
  const result = conflicts.get(screening.date);
  if (!result) return new Set([code]);
  let perDay = groupCache.get(result);
  if (!perDay) {
    perDay = new Map();
    groupCache.set(result, perDay);
  }
  const cached = perDay.get(code);
  if (cached) return cached;
  const group = conflictGroupFor(result, code) ?? new Set([code]);
  perDay.set(code, group);
  return group;
}

/** 在 React 里读「当前高亮哪一场」（订阅者自己那棵小树会重渲染）。 */
export function useHighlightedCode(): string | null {
  return useSyncExternalStore(subscribeHighlight, highlightedCode, highlightedCode);
}
