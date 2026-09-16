// 地图数据源适配层(2026-09-16,`PLAN-20260916232230` 修订 1)。
//
// ★ 为什么选 Naver / Kakao 而不是 Google:三件事都只是「按名称 + 地址查出这一家店」,
//   但 Naver 地域搜索 25,000 次/天、Kakao 关键词地点搜索 100,000 次/天,**都不用绑卡**;
//   Google Places 的 `rating` 落在 Text Search Enterprise SKU,免费只有 1,000 次/月
//   且要绑境外结算账号。韩国店本来就是本土数据源收录更全。
//
// ★ ⚠ Naver 与 Kakao 这两个接口**都不返回评分** —— 本层不假造 `rating`。
//   它们真正的价值是「精确到店的页面链接 + 道路名地址 + 坐标」:
//   把卡片上的「搜索链接」升级成「精确链接」,免得用户到了 Naver 还得再点一次搜索结果。
//
// ★ 归一化与网络调用**分开**(`normalizeNaver` / `normalizeKakao` 是纯函数),单测不必起 HTTP。

/** 三家数据源归一后的形状 —— 前端只认这一种,不关心上游是哪家。
 *  ⚠ 没有 `rating`:Naver 地域搜索与 Kakao 关键词搜索都不返回评分,别在类型上留个假字段。 */
export interface PlaceHit {
  provider: "naver" | "kakao";
  name: string;
  category: string;
  address: string;
  roadAddress: string;
  phone: string;
  lat: number | null;
  lng: number | null;
  /** 精确到店的页面(不是搜索页)—— 卡片优先用它替换搜索链接。 */
  url: string;
}

/** 上游超时。取数据源不该拖住页面 —— 超时就当「没查到」,卡片退回搜索链接。 */
export const LOOKUP_TIMEOUT_MS = 4_000;

/** 只在 `wrangler secret put` 里配的密钥,**不进 wrangler.jsonc**,
 *  所以不在 `wrangler types` 生成的 `Env` 里(本地有 `.dev.vars`、CI 没有,直接引用会让
 *  typecheck 在两边结果不一致)。这里显式声明成可选字段:没配就是 `undefined` → 自动降级。 */
export interface LookupSecrets {
  NAVER_CLIENT_ID?: string;
  NAVER_CLIENT_SECRET?: string;
  KAKAO_REST_API_KEY?: string;
}

export function lookupSecrets(env: Env): LookupSecrets {
  return env as unknown as LookupSecrets;
}

/** 去掉 Naver 返回里的高亮标签(`<b>국밥</b>`)。 */
export function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

/** 名称比对用的归一:去掉空白与标点,只留字母/数字/谚文/汉字。 */
function foldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^0-9a-z\uac00-\ud7a3\u4e00-\u9fff]/g, "");
}

/** 上游第一条结果未必是本店(尤其小馆子重名多)→ 名称要能互相包含才算命中。
 *  宁可返回 `null` 让卡片退回搜索链接,也不要挂一个错店的精确链接上去。 */
export function looksLikeMatch(query: string, hitName: string): boolean {
  const needle = foldName(query);
  const target = foldName(hitName);
  if (!needle || !target) return false;
  return needle.includes(target) || target.includes(needle);
}

/** 从韩文地址里挑出**行政区**名(`해운대구` / `중구` / `수영구` …),给检索串当地区限定词。
 *
 *  ★ 这一步是必需的,两个实测结论逼出来的:
 *    ① Kakao 关键词搜索对**长串**(店名 + 整条地址)直接返回 0 条 —— 40 家全灭;
 *    ② 只给店名会**全国排名**:`CU` 的第一名在济州、`오설록` 的第一名是济州博物馆。
 *    加上区名两件事一起解决(`오설록 해운대구` → 正确命中 해운대점)。
 *
 *  推不出区名时**宁可不查**(见 `lookupKakao`):没有地区约束的精确链接大概率是错的。 */
export function districtTokenOf(address: string): string {
  return (
    String(address ?? "")
      .split(/\s+/)
      .find((part) => part.length > 1 && /^.+[구군]$/.test(part)) ?? ""
  );
}

/** 命中必须落在同一个行政区 —— 名称闸门挡不住「名字对了、城市错了」。 */
function inDistrict(hit: PlaceHit, district: string): boolean {
  return `${hit.roadAddress} ${hit.address}`.includes(district);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCoord(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(asString(value));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

/** Naver 地域搜索响应 → 一条命中。`mapx`/`mapy` 是 **1e7 放大的 WGS84 整数**。 */
export function normalizeNaver(payload: unknown): PlaceHit | null {
  const root = asRecord(payload);
  const items = root?.items;
  if (!Array.isArray(items)) return null;
  const first = asRecord(items[0]);
  if (!first) return null;
  const name = stripTags(asString(first.title));
  if (!name) return null;
  const x = asCoord(first.mapx);
  const y = asCoord(first.mapy);
  return {
    provider: "naver",
    name,
    category: stripTags(asString(first.category)),
    address: asString(first.address),
    roadAddress: asString(first.roadAddress),
    phone: asString(first.telephone),
    lng: x === null ? null : x / 1e7,
    lat: y === null ? null : y / 1e7,
    url: asString(first.link),
  };
}

/** Kakao 关键词地点搜索响应 → 一条命中。`x` = 经度、`y` = 纬度(已经是十进制度)。 */
export function normalizeKakao(payload: unknown): PlaceHit | null {
  const root = asRecord(payload);
  const documents = root?.documents;
  if (!Array.isArray(documents)) return null;
  const first = asRecord(documents[0]);
  if (!first) return null;
  const name = asString(first.place_name);
  if (!name) return null;
  return {
    provider: "kakao",
    name,
    category: asString(first.category_name),
    address: asString(first.address_name),
    roadAddress: asString(first.road_address_name),
    phone: asString(first.phone),
    lng: asCoord(first.x),
    lat: asCoord(first.y),
    url: asString(first.place_url),
  };
}

async function getJson(url: string, init: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null; // 上游超时 / 被墙 / 配额用尽 —— 都当「没查到」,不把错误抛给页面
  }
}

export function naverConfigured(secrets: LookupSecrets): boolean {
  return Boolean(secrets.NAVER_CLIENT_ID && secrets.NAVER_CLIENT_SECRET);
}

export function kakaoConfigured(secrets: LookupSecrets): boolean {
  return Boolean(secrets.KAKAO_REST_API_KEY);
}

/** Naver 地域搜索。`name` 用于**闸门**,`searchText` 才是发给上游的检索串 —— 两者分开,
 *  因为检索串可以带地区限定词,而闸门只能拿店名比。 */
export async function lookupNaver(
  secrets: LookupSecrets,
  name: string,
  addressKr: string,
): Promise<PlaceHit | null> {
  if (!naverConfigured(secrets)) return null;
  const district = districtTokenOf(addressKr);
  const searchText = district ? `${name} ${district}` : name;
  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(searchText)}&display=5`;
  const payload = await getJson(url, {
    headers: {
      "X-Naver-Client-Id": secrets.NAVER_CLIENT_ID as string,
      "X-Naver-Client-Secret": secrets.NAVER_CLIENT_SECRET as string,
    },
  });
  const hit = normalizeNaver(payload);
  if (!hit || !looksLikeMatch(name, hit.name)) return null;
  // 推得出区名就要求落在同一区;推不出就不做地区校验(Naver 的本地库本身以韩国为主)
  return district && !inDistrict(hit, district) ? null : hit;
}

/** Kakao 关键词地点搜索。检索串 = `店名 + 区名`;**推不出区名就不查** ——
 *  没有地区约束时 Kakao 会全国排名,`CU` 的第一名在济州,挂上去就是错的精确链接。 */
export async function lookupKakao(
  secrets: LookupSecrets,
  name: string,
  addressKr: string,
): Promise<PlaceHit | null> {
  if (!kakaoConfigured(secrets)) return null;
  const district = districtTokenOf(addressKr);
  if (!district) return null;
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(`${name} ${district}`)}&size=5`;
  const payload = await getJson(url, {
    headers: { Authorization: `KakaoAK ${secrets.KAKAO_REST_API_KEY}` },
  });
  const hit = normalizeKakao(payload);
  if (!hit || !looksLikeMatch(name, hit.name)) return null;
  return inDistrict(hit, district) ? hit : null;
}
