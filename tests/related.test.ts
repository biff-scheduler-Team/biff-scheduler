// 豆瓣相关电影:映射表 → 本届落点;推荐列表拆成「本届 / 站外」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoubanRec, Mapping } from "../src/types";
import { MORE_CAP, indexFestival, loadRelated, recsOf, relatedOf, splitRelated } from "../src/related";

function rec(id: string, title = id): DoubanRec {
  return { id, title, url: `https://movie.douban.com/subject/${id}/` };
}

function mapping(code: string, subject_id: number): Mapping {
  return { code, subject_id, title_cn: null, douban_url: null };
}

describe("indexFestival:f### 与场次 code 归到同一 subject", () => {
  it("同一 subject 的目录 id 与第一场 code 都留下", () => {
    const mappings = new Map<string, Mapping>([
      ["003", mapping("003", 37269723)],
      ["f002", mapping("f002", 37269723)],
      ["156", mapping("156", 37269723)],
      ["f001", mapping("f001", 37019225)],
    ]);
    const fest = indexFestival(mappings);
    expect(fest.get("37269723")).toEqual({ filmId: "f002", code: "003" });
    expect(fest.get("37019225")).toEqual({ filmId: "f001", code: null });
  });

  it("没有 subject_id 的映射不进表", () => {
    const mappings = new Map<string, Mapping>([["x", { code: "x", subject_id: null, title_cn: null, douban_url: null }]]);
    expect(indexFestival(mappings).size).toBe(0);
  });
});

describe("splitRelated:本届提前、丢掉自身、站外封顶", () => {
  const fest = indexFestival(
    new Map([
      ["f010", mapping("f010", 1477317)],
      ["010", mapping("010", 1477317)],
      ["f011", mapping("f011", 1291569)],
    ])
  );
  const recs = [
    rec("2129924", "芝娜"),
    rec("1477317", "贝拉多娜"),
    rec("1467779", "自身"),
    rec("1291569", "大都会"),
    rec("1", "a"),
    rec("2", "b"),
    rec("3", "c"),
    rec("4", "d"),
    rec("5", "e"),
    rec("6", "f"),
    rec("7", "overflow"),
  ];

  it("本届按服务端顺序抽出,不含自身", () => {
    const { festival, more } = splitRelated(recs, "1467779", fest);
    expect(festival.map((r) => r.id)).toEqual(["1477317", "1291569"]);
    expect(more.map((r) => r.id)).toEqual(["2129924", "1", "2", "3", "4", "5"]);
    expect(more).toHaveLength(MORE_CAP);
  });

  it("源不在本届、推荐全站外 → festival 空, more 仍封顶", () => {
    const { festival, more } = splitRelated([rec("1"), rec("2")], "999", fest);
    expect(festival).toEqual([]);
    expect(more.map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("loadRelated:缺文件静默空表", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ recs: {} }) })));
    await loadRelated();
  });

  it("200 + recs 灌进 recsOf;relatedOf 能拆出本届", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ recs: { "1467779": [rec("1477317", "贝拉多娜"), rec("2129924", "芝娜")] } }),
      }))
    );
    await loadRelated();
    expect(recsOf(1467779)).toHaveLength(2);
    const mappings = new Map([["f010", mapping("f010", 1477317)]]);
    const split = relatedOf(1467779, mappings);
    expect(split.festival.map((r) => r.title)).toEqual(["贝拉多娜"]);
    expect(split.more.map((r) => r.title)).toEqual(["芝娜"]);
  });

  it("fetch 失败 → 保留上一轮(空表),不抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await loadRelated();
    expect(recsOf("1467779")).toEqual([]);
  });
});
