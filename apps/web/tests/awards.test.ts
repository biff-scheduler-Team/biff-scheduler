// 获奖信息的纯函数 / 加载口径。
//
// 为什么单测它:获奖数据是**外部产物**(官网颁奖报道 → `awards.json`),前端只查表。
// 失效方式全是静默的 —— 文件缺失、结构变了、翻译表没命中,表现都只是「徽章不见了」,
// 没有任何报错。这里把「查得到 / 查不到 / 没中文名」三条口径钉住。
//
// 2026-10-15 立(`PLAN-20261015142133`)。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awardBadgeTip,
  awardLabel,
  awardWho,
  awardsForCode,
  awardsForFilms,
  indexAwards,
  loadAwards,
} from "../src/awards";
import type { AwardItem, AwardsFile } from "../src/types";

const filmAward: AwardItem = {
  award: "NETPAC Award",
  awardZh: "NETPAC 奖",
  recipient: "Zogsool",
  director: "SAKHYA Byamba",
  film: "Zogsool",
  person: "",
  filmIds: ["f204"],
  filmZh: "野马",
  codes: ["373", "511"],
};

const actorAward: AwardItem = {
  award: "Actor of the Year",
  awardZh: null, // 未登记中文名 → 界面回落英文原文
  recipient: "WON Hyangra",
  director: "",
  film: "Beyond Love′s Horizon",
  person: "WON Hyangra",
  filmIds: ["f192"],
  filmZh: "爱之彼岸",
  codes: [],
};

const FILE: AwardsFile = {
  source: "https://www.biff.kr/eng/artyboard/mboard.asp",
  generated_at: "2026-10-15T00:00:00+09:00",
  ceremony: { date: "2026-10-14", venue: "SIGNIEL BUSAN Grand Ballroom" },
  awards: [filmAward, actorAward],
  people: [
    {
      award: "Camellia Award",
      awardZh: "山茶花奖",
      name: "Ann HUI",
      labels: ["Hong Kong, China", "Director"],
      filmIds: [],
      codes: [],
    },
  ],
};

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => FILE })));
  await loadAwards();
});

describe("索引:场次 code / 目录影片 id 双键", () => {
  it("按场次 code 查得到这部片的奖项", () => {
    expect(awardsForCode("373").map((a) => a.award)).toEqual(["NETPAC Award"]);
    expect(awardsForCode("511").map((a) => a.award)).toEqual(["NETPAC Award"]);
  });

  it("没有奖的场次返回空数组(而不是 undefined)", () => {
    expect(awardsForCode("999")).toEqual([]);
  });

  it("按目录 id 查得到,且去重(同一部片多场只返回一条奖项)", () => {
    expect(awardsForFilms(["f204"]).map((a) => a.award)).toEqual(["NETPAC Award"]);
    expect(awardsForFilms(["f204", "f204"]).map((a) => a.award)).toEqual(["NETPAC Award"]);
    expect(awardsForFilms(["f192", "f204"]).map((a) => a.award)).toEqual([
      "Actor of the Year",
      "NETPAC Award",
    ]);
  });

  it("空 id 组不炸(影片没有目录条目时)", () => {
    expect(awardsForFilms([undefined, null, ""])).toEqual([]);
  });
});

describe("文案", () => {
  it("有中文名用中文,没有回落官网英文原文(不硬译)", () => {
    expect(awardLabel(filmAward)).toBe("NETPAC 奖");
    expect(awardLabel(actorAward)).toBe("Actor of the Year");
  });

  it("影片奖印导演、演员奖印「人名(片名)」", () => {
    expect(awardWho(filmAward)).toBe("导演 SAKHYA Byamba");
    expect(awardWho(actorAward)).toBe("WON Hyangra（Beyond Love′s Horizon）");
  });

  it("徽章 hover 首行说明是什么,之后一行一个奖项", () => {
    const tip = awardBadgeTip([filmAward]);
    const lines = tip.split("\n");
    expect(lines[0]).toContain("获奖");
    expect(lines[1]).toBe("· NETPAC 奖 —— 导演 SAKHYA Byamba");
  });
});

describe("缺文件 / 结构异常时静默降级", () => {
  // ⚠ 失败路径必须用**干净的模块**测:成功过一次之后,模块里已有数据,
  //   再加载失败会**保留旧数据**(这是有意的 —— 单例只在 bootstrap 调一次,
  //   失败就当没这回事,不清空已经可用的索引)。故这里 resetModules 后重新 import。
  it("首次加载遇到 404:不抛错,查不到任何奖项", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const mod = await import("../src/awards");
    await mod.loadAwards();
    expect(mod.awardsForCode("373")).toEqual([]);
    expect(mod.awardPeople()).toEqual([]);
  });

  it("首次加载时 fetch 抛错(旧部署 / 断网):同样不抛", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const mod = await import("../src/awards");
    await expect(mod.loadAwards()).resolves.toBeUndefined();
    expect(mod.awardsForCode("373")).toEqual([]);
  });

  it("indexAwards(null) 得到空索引", () => {
    const index = indexAwards(null);
    expect(index.byCode.size).toBe(0);
    expect(index.byFilmId.size).toBe(0);
  });
});
