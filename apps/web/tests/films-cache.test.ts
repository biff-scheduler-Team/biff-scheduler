// films 派生缓存的回归测试（2026-09-23，PLAN-20260923113659 T3）。
//
// 为什么必须钉住：`store.tsx::derive` 的 useMemo 依赖 `[cat, version]`，而 `version` 在**任何**
// 一次变更后都会自增 —— 此前「点选一场片」就要重算整届 `buildFilms`（795 场 → 影片节点）。
// films 只依赖目录与豆瓣映射，与选片无关，故加了缓存；本文件的职责是把「缓存不许吞掉映射回填 /
// P&I 开关」这条边界锁死 —— 缓存最大的风险正是「该重建时没重建」。
//
// 纯逻辑，不碰 DOM（vitest environment = node）。

import { describe, expect, it } from "vitest";
import { buildFilms, buildFilmsCached } from "../src/app/model";
import { catalog, show } from "./helpers";

const mappings = (entries: Array<[string, string]>) =>
  new Map(entries.map(([code, title]) => [code, { code, title_cn: title } as never]));

describe("buildFilmsCached", () => {
  it("★ 同一映射版本重复调用 → 返回同一数组（点选变化不重建 films）", () => {
    const cat = catalog([show({ code: "001" })]);
    const map = mappings([]);
    const first = buildFilmsCached(cat, cat, map, 0);
    const second = buildFilmsCached(cat, cat, map, 0);
    expect(second).toBe(first);
    // 与无缓存版本的结果一致（内容不能因为缓存而不同）
    expect(second).toEqual(buildFilms(cat, map));
  });

  it("映射版本变化 → 重建，且新映射真的进了结果（缓存不吞掉回填）", () => {
    const cat = catalog([show({ code: "001" })]);
    const map = mappings([]);
    const before = buildFilmsCached(cat, cat, map, 0);
    map.set("001", { code: "001", title_cn: "回填的中文名" } as never);
    const after = buildFilmsCached(cat, cat, map, 1);
    expect(after).not.toBe(before);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it("P&I 开关（`effective !== base`）→ 重建（`withPni` 每次返回新对象，不能当键用）", () => {
    const base = catalog([show({ code: "001" })]);
    // ⚠ 两部片的 `title_en` 必须不同：`filmNodeKey` 按片名归并，同名会被算成同一部（影片数不变）
    const merged = catalog([show({ code: "001" }), show({ code: "002", title_en: "Other Film" })]);
    const map = mappings([]);
    const plain = buildFilmsCached(base, base, map, 0);
    const withPni = buildFilmsCached(base, merged, map, 0);
    expect(withPni).not.toBe(plain);
    expect(withPni.length).toBeGreaterThan(plain.length);
    // 再切回不带 P&I：键里的 pni 标记已变 → 必须重建。
    // ⚠ 这里断言 `toEqual` 而不是 `toBe`：缓存每个 base 只留**最新一条**（不是按 pni 分桶），
    //    所以「切回来」是重建出一份内容相同的新数组，而不是复用最初那份实例。
    expect(buildFilmsCached(base, base, map, 0)).toEqual(plain);
  });

  it("不同目录（data 更新）各自独立成缓存", () => {
    const one = catalog([show({ code: "001" })]);
    const two = catalog([show({ code: "001" }), show({ code: "002", title_en: "Other Film" })]);
    const map = mappings([]);
    const a = buildFilmsCached(one, one, map, 0);
    const b = buildFilmsCached(two, two, map, 0);
    expect(a).not.toBe(b);
    expect(b.length).toBeGreaterThan(a.length);
  });
});
