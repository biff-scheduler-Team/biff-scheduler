// 地图数据源适配层(2026-09-16,`PLAN-20260916232230` 修订 1)。
// 覆盖:两家上游的响应归一、名称匹配闸门、缺密钥时不发请求、上游报错时静默降级。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  districtTokenOf,
  kakaoConfigured,
  looksLikeMatch,
  lookupKakao,
  lookupNaver,
  normalizeKakao,
  normalizeNaver,
  naverConfigured,
  stripTags,
  type LookupSecrets,
} from "../src/place-lookup";

const both: LookupSecrets = {
  NAVER_CLIENT_ID: "naver-id",
  NAVER_CLIENT_SECRET: "naver-secret",
  KAKAO_REST_API_KEY: "kakao-key",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stripTags", () => {
  it("去掉 Naver 的高亮标签", () => {
    expect(stripTags("<b>60년전통</b>할매국밥")).toBe("60년전통할매국밥");
    expect(stripTags("  <b>공백</b>  ")).toBe("공백");
  });
});

describe("normalizeNaver", () => {
  it("mapx/mapy 是 1e7 放大的 WGS84 整数 → 归一成十进制度", () => {
    const hit = normalizeNaver({
      items: [
        {
          title: "<b>60년전통할매국밥</b>",
          link: "https://map.naver.com/p/entry/place/123",
          category: "음식점>한식>국밥",
          description: "",
          telephone: "",
          address: "부산 동구 초량동 123",
          roadAddress: "부산 동구 중앙대로533번길 4",
          mapx: "1290394000",
          mapy: "3511560000",
        },
      ],
    });
    expect(hit?.provider).toBe("naver");
    expect(hit?.name).toBe("60년전통할매국밥");
    expect(hit?.roadAddress).toBe("부산 동구 중앙대로533번길 4");
    expect(hit?.lng).toBeCloseTo(129.0394, 5);
    expect(hit?.lat).toBeCloseTo(351.156, 5 / 2);
    expect(hit?.url).toContain("map.naver.com");
  });

  it("空 items / 结构不对 → null", () => {
    expect(normalizeNaver({ items: [] })).toBeNull();
    expect(normalizeNaver({})).toBeNull();
    expect(normalizeNaver(null)).toBeNull();
  });

  it("只有标签没有文字的名字当作无效", () => {
    expect(normalizeNaver({ items: [{ title: "<b></b>" }] })).toBeNull();
  });
});

describe("normalizeKakao", () => {
  it("x/y 已经是十进制度,直接采用", () => {
    const hit = normalizeKakao({
      documents: [
        {
          place_name: "오복돼지국밥",
          category_name: "음식점 > 한식",
          phone: "051-123-4567",
          address_name: "부산 해운대구 우동 123",
          road_address_name: "부산 해운대구 해운대로143번길 17",
          x: "129.1635",
          y: "35.1625",
          place_url: "http://place.map.kakao.com/12345",
        },
      ],
    });
    expect(hit?.provider).toBe("kakao");
    expect(hit?.lng).toBeCloseTo(129.1635, 4);
    expect(hit?.lat).toBeCloseTo(35.1625, 4);
    expect(hit?.phone).toBe("051-123-4567");
  });

  it("该接口不返回评分 —— 归一结果里也不该出现 rating 字段", () => {
    const hit = normalizeKakao({ documents: [{ place_name: "测试", x: "1", y: "2" }] });
    expect(hit).not.toBeNull();
    expect(Object.keys(hit as object)).not.toContain("rating");
  });

  it("空 documents / 结构不对 → null", () => {
    expect(normalizeKakao({ documents: [] })).toBeNull();
    expect(normalizeKakao({ items: [] })).toBeNull();
  });
});

describe("名称匹配闸门", () => {
  it("互相包含才算命中(忽略空白与标点)", () => {
    expect(looksLikeMatch("60년전통할매국밥 부산 동구", "60년전통할매국밥")).toBe(true);
    expect(looksLikeMatch("독일김밥", "독일김밥 부산센텀점")).toBe(true);
    expect(looksLikeMatch("사마정", "사마정")).toBe(true);
  });

  it("完全不同的店判为不命中 —— 宁可退回搜索链接,也不挂错店的精确链接", () => {
    expect(looksLikeMatch("사마정", "스타벅스 센텀KNN점")).toBe(false);
    expect(looksLikeMatch("", "아무거나")).toBe(false);
    expect(looksLikeMatch("店", "")).toBe(false);
  });
});

describe("区名提取", () => {
  it("挑出「구/군」结尾的行政区 —— 这是给 Kakao 收窄范围的关键", () => {
    expect(districtTokenOf("부산 해운대구 센텀서로 30 (우동)")).toBe("해운대구");
    expect(districtTokenOf("부산 중구 자갈치로23번길 6 백화양곱창6호")).toBe("중구");
    expect(districtTokenOf("수영구 민락로13번길 21 1층 광안리 끄티집")).toBe("수영구");
  });

  it("地址里没有区名 → 空串(调用方据此**放弃查询**,而不是无约束地全国搜)", () => {
    expect(districtTokenOf("해운대구 구남로 14")).toBe("해운대구");
    expect(districtTokenOf("海云台站3号出口左街沿路尽头的街头小吃")).toBe("");
    expect(districtTokenOf("")).toBe("");
    expect(districtTokenOf("스럼프월드센텀 1층 118-1호")).toBe("");
  });

  it("单字地名不算(别把「동」这种后缀误当行政区)", () => {
    expect(districtTokenOf("우동 1505번지")).toBe("");
  });
});

describe("密钥配置", () => {
  it("两个都缺 → 都算未配置", () => {
    expect(naverConfigured({})).toBe(false);
    expect(kakaoConfigured({})).toBe(false);
    expect(naverConfigured({ NAVER_CLIENT_ID: "only-id" })).toBe(false);
  });

  it("配齐 → true", () => {
    expect(naverConfigured(both)).toBe(true);
    expect(kakaoConfigured(both)).toBe(true);
  });
});

describe("上游调用", () => {
  const ADDRESS = "부산 해운대구 센텀서로 30 (우동)";

  it("未配置密钥时**根本不发请求**", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await lookupNaver({}, "아무거나", ADDRESS)).toBeNull();
    expect(await lookupKakao({}, "아무거나", ADDRESS)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("上游非 2xx / 抛异常 → null(不把错误抛给页面)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await lookupNaver(both, "아무거나", ADDRESS)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await lookupKakao(both, "아무거나", ADDRESS)).toBeNull();
  });

  it("检索串带区名,且与闸门用的店名分开 —— 长串会让 Kakao 返回 0 条", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [] }) });
    vi.stubGlobal("fetch", fetchSpy);
    await lookupKakao(both, "오설록", ADDRESS);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).toContain("query=오설록 해운대구");
    expect(decodeURIComponent(url)).not.toContain("센텀서로");
  });

  it("推不出区名时 Kakao **直接放弃** —— 无地区约束的首条结果是全国排名,大概率是错的", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await lookupKakao(both, "씨앗호떡", "海云台站3号出口的街头小吃")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("命中但店名对不上 → null;对得上 → 返回命中", async () => {
    const payload = {
      items: [
        {
          title: "스타벅스 센텀KNN점",
          link: "https://map.naver.com/x",
          roadAddress: "부산 해운대구 센텀서로 30",
          mapx: "1",
          mapy: "2",
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    expect(await lookupNaver(both, "사마정", ADDRESS)).toBeNull();
    expect((await lookupNaver(both, "스타벅스 센텀KNN점", ADDRESS))?.name).toBe("스타벅스 센텀KNN점");
  });

  it("**名字对了但城市错了**必须挡掉 —— 名称闸门挡不住,靠行政区校验", async () => {
    const jejuCu = {
      documents: [
        {
          place_name: "CU 혼저옵서예점",
          address_name: "제주특별자치도 제주시 애월읍 1",
          road_address_name: "제주특별자치도 제주시 애월로 1",
          x: "126.3",
          y: "33.4",
          place_url: "http://place.map.kakao.com/1",
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => jejuCu }));
    // 名字闸门本身会放行(「CU」包含在「CU 혼저옵서예점」里),但经开区校验必须拒绝
    expect(looksLikeMatch("CU", "CU 혼저옵서예점")).toBe(true);
    expect(await lookupKakao(both, "CU", ADDRESS)).toBeNull();
  });

  it("请求带上了正确的鉴权头 —— 密钥只在服务端,不进 query", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [] }) });
    vi.stubGlobal("fetch", fetchSpy);
    await lookupKakao(both, "아무거나", ADDRESS);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("dapi.kakao.com/v2/local/search/keyword.json");
    expect(url).not.toContain("kakao-key");
    expect((init.headers as Record<string, string>).Authorization).toBe("KakaoAK kakao-key");
  });
});
