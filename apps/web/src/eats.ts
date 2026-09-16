// 「吃喝」——《BIFF吃喝》餐厅清单(2026-09-16,`PLAN-20260916232230`)。
//
// ★ 数据从哪来:离线管线 `tools/build_eats.py` 读表格导出 → 产出 `public/eats.json`(产物检入仓库)。
//   不在构建时实抓腾讯文档 —— 那边是 canvas 渲染 + 私有 protobuf,没有公开契约(见 PLAN「方案取舍」)。
//
// ★ 地图跳转为什么有三个:「韩国店在 Naver 的收录率高于 Google」是选片现场的共识,
//   表里又正好有韩文名,所以 Google / Naver / Kakao 各给一个入口。三条都是普通 URL,
//   **不需要任何 API Key、不消耗任何配额** —— 这也是本轮刻意不接 Places API 的原因。
//   链接模板一律从 `legend.ts` 取,本模块不自己拼 URL(否则就是第二份口径)。
//
// ★ 用户提交的店铺:`biff.eats.v1`,**默认只存本地**;登录 IFFDAY 后经既有账号同步链路
//   传到该账号自己那份(`sync-data.ts` 按 `biff.` 前缀原样收纳,无需改动同步层)。
//
// ⚠ 本模块在 import 期**不碰 DOM / localStorage**(单测跑在 node 环境),读盘一律走函数。

import { kakaoMapUrlForQuery, mapsUrlForQuery, naverMapUrlForQuery } from "./legend";
import { writeWorkspaceItem } from "./workspace-storage";

/** 静态清单里的一家店,字段与 `tools/build_eats.py` 的产物一一对应(改这里必须同步改那边)。 */
export interface EatShop {
  id: string;
  name_kr: string;
  name_en: string;
  name_zh: string;
  hours: string;
  menu: string;
  price: string;
  address_kr: string;
  address_en: string;
  note: string;
  link: string;
  district: string;
}

export interface EatsFile {
  generated_at: string;
  source: string;
  notice: string;
  shops: EatShop[];
}

/** 用户自己提交的店铺 —— 结构刻意比 `EatShop` 宽松:用户不会去填三语名和两种地址。 */
export interface EatSubmission {
  id: string;
  name: string;
  district: string;
  address: string;
  note: string;
  created_at: number;
}

/** 本地键名。以 `biff.` 开头 → 自动进备份与账号同步,不必改 `sync-data.ts`。 */
export const EATS_KEY = "biff.eats.v1";

/** 上限:本地键与云端同步值都是「整键字符串」,无上限会让单键无限膨胀(服务端单值上限 64KB)。 */
export const MAX_SUBMISSIONS = 200;

export const DISTRICT_LABEL: Record<string, string> = {
  haeundae: "海云台",
  suyeong: "水营",
  junggu: "中区",
  donggu: "东区",
  busanjin: "釜山镇",
  other: "其他",
};

export function districtLabel(code: string): string {
  return DISTRICT_LABEL[code] ?? DISTRICT_LABEL.other;
}

/** 展示用主名:中文优先(用户在中文语境里认得出),没有才退回韩文 / 英文。 */
export function eatName(shop: EatShop): string {
  return shop.name_zh || shop.name_kr || shop.name_en;
}

/** 副名(韩文名优先)—— 到了现场给店家看这个最有用。 */
export function eatSubName(shop: EatShop): string {
  const name = eatName(shop);
  return shop.name_kr === name ? shop.name_en : shop.name_kr || shop.name_en;
}

/** 检索串:优先韩文名 —— 三个地图对韩文名的命中率都最高;缀上韩文地址帮地图消歧。
 *  ⚠ 只在 `name_kr` 缺失时才用中文名,因为中文名在韩国地图上基本搜不到。 */
export function eatQuery(shop: Pick<EatShop, "name_kr" | "name_zh" | "name_en" | "address_kr" | "address_en">): string {
  const name = shop.name_kr || shop.name_zh || shop.name_en;
  const address = shop.address_kr || shop.address_en;
  return address ? `${name} ${address}` : name;
}

export interface EatLinks {
  google: string;
  naver: string;
  kakao: string;
}

/** 三条地图链接 —— 页面直接遍历渲染,不要在每个组件里各拼一次。 */
export function eatLinks(query: string): EatLinks {
  return {
    google: mapsUrlForQuery(query),
    naver: naverMapUrlForQuery(query),
    kakao: kakaoMapUrlForQuery(query),
  };
}

/** 表里「链接」列那条**人工整理**的链接(小红书 / naver.me / instagram)。
 *  含金量高于自动搜索 —— naver.me 是精确到店的短链,小红书写的是这家店的食记。
 *  按域名给个人话的标签,别在卡片上印一个光秃秃的 URL。 */
export function eatLinkLabel(url: string): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.endsWith("xiaohongshu.com")) return "小红书";
    if (host === "naver.me" || host === "naver.com" || host.endsWith(".naver.com")) return "Naver 店铺";
    if (host.endsWith("instagram.com")) return "Instagram";
    return host;
  } catch {
    return "原始链接";
  }
}

/* ---------------- 地图数据源查询(Naver / Kakao) ----------------
 * 走 Worker 代理 `/api/eats/lookup` —— 密钥只存在服务端,不下发浏览器。
 *
 * ★ 拿它做什么:把卡片上的「搜索链接」升级成**精确到店的页面链接**,顺带补出电话。
 * ★ 拿它不做什么:**不显示评分** —— Naver 地域搜索与 Kakao 关键词搜索都不返回评分
 *   (Google 那个有评分,但落在 Enterprise SKU、免费仅 1,000 次/月,本轮不接)。
 * ★ 没配密钥时服务端回 503,这里**记住一次就再也不问**(`disabled`),
 *   页面全程静默降级成三个搜索链接 —— 用户不会看到任何「服务不可用」的噪声。 */

export interface PlaceHit {
  provider: "naver" | "kakao";
  name: string;
  category: string;
  address: string;
  roadAddress: string;
  phone: string;
  lat: number | null;
  lng: number | null;
  url: string;
}

const lookupCache = new Map<string, PlaceHit | null>();
let lookupOff = false;

/** 服务端没配密钥(或已判定不可用)→ 页面别再打这个端点。 */
export function lookupDisabled(): boolean {
  return lookupOff;
}

/** 查一家店。失败 / 未配置 / 查不到一律 `null` —— 调用方只需判断「有没有精确链接」。
 *  ⚠ 传**店名**与**韩文地址**两个字段(不是一个拼好的长串):上游要用区名收窄范围,
 *  而闸门只能拿店名比 —— 拼在一起会两头都做不好(实测过,见 `place-lookup.ts::districtTokenOf`)。 */
export async function lookupPlace(name: string, address: string): Promise<PlaceHit | null> {
  if (lookupOff || !name) return null;
  const key = `${name}\u0000${address}`;
  const cached = lookupCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const params = new URLSearchParams({ name, address });
    const res = await fetch(`/api/eats/lookup?${params}`, { credentials: "same-origin" });
    if (res.status === 503) {
      lookupOff = true;
      return null;
    }
    if (!res.ok) {
      lookupCache.set(key, null);
      return null;
    }
    const payload = (await res.json()) as { hit?: PlaceHit | null };
    const hit = payload?.hit && typeof payload.hit.url === "string" ? payload.hit : null;
    lookupCache.set(key, hit);
    return hit;
  } catch {
    // 网络抖动不写缓存,也不置 disabled —— 下一次还有机会
    return null;
  }
}

/** 读静态清单。文件缺失 / 旧部署没有它 → `null`,页面走空态(与 `data.ts::loadJson` 同口径)。 */
export async function loadEatsFile(): Promise<EatsFile | null> {
  try {
    const res = await fetch("/eats.json", { cache: "default" });
    if (!res.ok) return null;
    const file = (await res.json()) as EatsFile;
    return Array.isArray(file?.shops) ? file : null;
  } catch {
    return null;
  }
}

/** 读用户提交的店铺。值损坏 / 不是数组 → 空数组,不抛(坏数据不该让整页打不开)。 */
export function readSubmissions(): EatSubmission[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(EATS_KEY);
  } catch {
    return []; // 隐私模式下 localStorage 可能直接抛
  }
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is EatSubmission =>
        !!item && typeof item === "object" && typeof (item as EatSubmission).id === "string",
    );
  } catch {
    return [];
  }
}

function persist(list: EatSubmission[]): EatSubmission[] {
  // 新提交排前面 —— 用户刚填完就想在列表里看到它
  const capped = list.slice(0, MAX_SUBMISSIONS);
  writeWorkspaceItem(EATS_KEY, JSON.stringify(capped));
  return capped;
}

export function addSubmission(input: Omit<EatSubmission, "id" | "created_at">): EatSubmission[] {
  const entry: EatSubmission = {
    ...input,
    id: `user:${crypto.randomUUID()}`,
    created_at: Date.now(),
  };
  return persist([entry, ...readSubmissions()]);
}

export function removeSubmission(id: string): EatSubmission[] {
  return persist(readSubmissions().filter((item) => item.id !== id));
}
