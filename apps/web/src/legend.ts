// 徽章**外观**不在这里:`legend.ts` / `badges.ts` 只负责文案(标签 / hover 说明 / 官方英文)。
// 形状与配色统一由 `.film-badge[data-badge=…]` 承载(token 见 `style.css` 的 `--badge-*`)——
// 2026-09-23,`PLAN-20260923113659` T1:此前这里另有一份 `cls`(CHIP_BASE/CHIP_SOLID + bg-rate-*-solid),
// 零消费方且那些 Tailwind 类在新 `src` 没有定义 —— 同一外观两份定义,改哪份都不确定生效。

import type {RatingKey, SubsKey, Screening, Venue} from './types';

interface RateDef {
  label: string;
  zh: string; // 中文说明
  kr: string; // 한국어 표기
  en: string; // 官方准入英文
  tip: string; // hover 说明(悬停在具体徽章上即示)
}

export const RATING_DEFS: Record<RatingKey, RateDef> = {
  ALL: {
    label: "ALL",
    zh: "全年龄",
    kr: "전체관람가",
    en: "All ages admitted",
    tip: "观影等级 ALL — 全年龄可观看\n전체관람가 · All ages admitted",
  },
  "12": {
    label: "12",
    zh: "12 岁以上",
    kr: "12세이상관람가",
    en: "Under 12 not admitted",
    tip: "观影等级 12(12세이상관람가)\n未满 12 岁不得入场 · Under 12 not admitted",
  },
  "15": {
    label: "15",
    zh: "15 岁以上",
    kr: "15세이상관람가",
    en: "Under 15 not admitted",
    tip: "观影等级 15(15세이상관람가)\n未满 15 岁不得入场 · Under 15 not admitted",
  },
  "19": {
    label: "19",
    zh: "19 岁以上",
    kr: "청소년관람불가",
    en: "Under 19 not admitted",
    tip: "观影等级 19(청소년관람불가)\n未满 19 岁不得入场 · Under 19 not admitted",
  },
};

interface SubsDef {
  label: string;
  en: string; // 官方英文全称
  zh: string; // 中文释义
  tip: string;
}

export const SUBS_DEFS: Record<SubsKey, SubsDef> = {
  KE: {
    label: "KE",
    en: "Korean Subtitles + English Subtitles or Dialogue",
    zh: "韩文字幕 + 英文字幕或英文对白(最常见)",
    tip: "字幕 KE — Korean Subtitles + English Subtitles or Dialogue\n韩文字幕 + 英文字幕或英文对白",
  },
  KN: {
    label: "KN",
    en: "Korean Subtitles + Non-English Dialogue without English Subtitles",
    zh: "韩文字幕 + 非英语外语对白(无英字;外语观众慎选)",
    tip: "字幕 KN — Korean Subtitles + Non-English Dialogue without English Subtitles\n韩文字幕 + 非英语外语对白,不配英文字幕\n多为日 / 中 / 西语对白片,不熟该语言需留意",
  },
  KK: {
    label: "KK",
    en: "Korean Subtitles + Korean Dialogue",
    zh: "韩文字幕 + 韩语对白(无外文字幕)",
    tip: "字幕 KK — Korean Subtitles + Korean Dialogue\n韩文字幕 + 韩语对白(无外文字幕;同时为听障观众提供语音 / 字幕解说)",
  },
  NO: {
    label: "NO",
    en: "No Dialogue",
    zh: "无对白(实验 / 纪录 / 纯影像)",
    tip: "字幕 NO — No Dialogue\n无对白影片(实验 / 纪录 / 纯影像)",
  },
};

export const RATING_ORDER: RatingKey[] = ["ALL", "12", "15", "19"];

export function subsKeys(subs: Screening["subs"] | SubsKey): SubsKey[] {
  if (!subs) return [];
  return Array.isArray(subs) ? subs : [subs];
}

export function pageTip(page: number): string {
  return `节目册页码 P.${page}\n该场在官方 Ticket Catalogue(节目册)中的页码\n购票 / 翻册对表用`;
}

/** 影院 → 分区说明(图例「分区」列 / 场次行影院章 hover 用)。key 必须与 `venues.json`
 *  的 `group` 一致,否则整列渲染成 `—`。
 *
 *  ⚠ **分区以 `venues.json` 的 `region` 为准,这里只是它的中文写法** ——
 *  `apps/web/tests/venue-region-parity.test.ts` 逐条比对「数据 region ↔ 本表前缀 ↔ 旧版同表」,
 *  改这里之前先改数据(2026-09-14:旧版曾把 sohyang / bcm 误归南浦洞,被该测试钉住)。
 *  ⚠ `megabox` 条目**保留**:MEGABOX Busan Theater 本来就属南浦洞(官方三区模型),
 *  只是 2026 未参与 —— 删掉是丢一条正确信息,不是清残留。 */
const GROUP_AREA: Record<string, string> = {
  bcc: "CENTUM 主场区 · 电影殿堂(Busan Cinema Center)",
  cgv: "CENTUM 主场区 · CGV Centum City",
  lotte: "CENTUM 主场区 · LOTTE CINEMA Centum City",
  kofic: "CENTUM 主场区 · KOFIC Theater(电影振兴委员会)",
  shinsegae: "CENTUM 主场区 · 新世界 Centum City 文化厅",
  dsumedia: "CENTUM 主场区 · 东西大学-KIT Centum Campus",
  megabox: "南浦洞 · MEGABOX Busan Theater",
  sohyang: "CENTUM 主场区 · 东西大学 Sohyang Theatre",
  bcm: "CENTUM 主场区 · 釜山市民媒体中心",
};

const REGION_LABEL: Record<string, string> = {
  centum: "CENTUM 主场区",
  nampo: "南浦洞",
};

/** 影院级地点信息(按 `Venue.group` 聚合,同一影院下的多个厅共用同一地址)。
 *
 *  **来源**:BIFF 官网 Theater Regulations(`page_num=11238`,2026 口径)——
 *  英文名 / 街道地址 / 楼层厅位均为官网原文;韩文地址供本地导航与复制。
 *
 *  ⚠ **2026-09-14 起 `nampo` 分区重新有数据**:Community BIFF(10/8–10/11)在
 *  MEGABOX Busan Theater 1–4(南浦洞)有 42 场,由官方 Ticket Catalogue PDF 补入
 *  —— 官网排期页**不列**该影院,只列册子(见 `tools/merge_schedule.py` 文件头)。
 *  跨区转场(centum ↔ nampo)缓冲因此重新会触发,别再按「本届只有一个分区」推断。
 *  ⚠ `megabox` **故意没有** `VENUE_PLACES` 条目:官网 Theater Regulations 页取不到该影院,
 *  街道地址无法按「官网原文」口径登记 —— 弹层回退成「厅名 + 分区」,**不编造地址**。
 */
export interface VenuePlace {
  /** 影院官方英文名(与官网一致) */
  name: string;
  /** 影院中文名(无官方中文名时为译名,仅作提示) */
  nameZh: string;
  /** 韩文名(本地导航 / 复制用) */
  nameKr: string;
  /** 街道地址(英文,官网原文) */
  address: string;
  /** 街道地址(韩文) */
  addressKr: string;
  /** 建筑内位置(楼层 / 厅名,官网原文) */
  location: string;
  /** 分区:centum = CENTUM 主场区 / nampo = 南浦洞 */
  region: "centum" | "nampo";
}

export const VENUE_PLACES: Record<string, VenuePlace> = {
  bcc: {
    name: "Busan Cinema Center",
    nameZh: "电影殿堂",
    nameKr: "영화의전당",
    address: "120, Suyeonggangbyeon-daero, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 수영강변대로 120",
    location: "主会场,开闭幕式与 BIFF Theatre 所在地",
    region: "centum",
  },
  cgv: {
    name: "CGV Centum City",
    nameZh: "CGV Centum City",
    nameKr: "CGV 센텀시티",
    address: "35, Centum nam-daero, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀남대로 35",
    location: "新世界 Centum City 7F",
    region: "centum",
  },
  lotte: {
    name: "LOTTE CINEMA Centum City",
    nameZh: "乐天影院 Centum City",
    nameKr: "롯데시네마 센텀시티",
    address: "59, Centum nam-daero, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀남대로 59",
    location: "乐天百货 Centum City 8F",
    region: "centum",
  },
  kofic: {
    name: "KOFIC Theater",
    nameZh: "电影振兴委员会试映室",
    nameKr: "영화진흥위원회 표준시사실",
    address: "130, Suyeonggangbyeon-daero, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 수영강변대로 130",
    location: "KOFIC 2F",
    region: "centum",
  },
  shinsegae: {
    name: "Culture Hall, Shinsegae Centum City",
    nameZh: "新世界 Centum City 文化厅",
    nameKr: "신세계 센텀시티 문화홀",
    address: "35, Centum nam-daero, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀남대로 35",
    location: "新世界 Centum City 9F",
    region: "centum",
  },
  dsumedia: {
    name: "DSU-KIT Centum Campus",
    nameZh: "东西大学 Centum 校区",
    nameKr: "동서대학교 센텀캠퍼스",
    address: "55, Centum jungang-ro, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀중앙로 55",
    location: "Book Cafe Lounge 4F",
    region: "centum",
  },
  sohyang: {
    name: "Sohyang Theatre Woori Bank Hall",
    nameZh: "素香剧场 友利银行厅",
    nameKr: "소향씨어터 우리은행홀",
    address: "55, Centum jungang-ro, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀중앙로 55",
    location: "东西大学 Centum 校区内,우리은행홀",
    region: "centum",
  },
  bcm: {
    name: "Busan Community Media Center Open Hall",
    nameZh: "釜山市民媒体中心 公开厅",
    nameKr: "부산시청자미디어센터 공개홀",
    address: "42, Centum jungang-ro, Haeundae-gu, Busan",
    addressKr: "부산 해운대구 센텀중앙로 42",
    location: "2F Open Hall",
    region: "centum",
  },
};

export function venueShort(v: Venue): string {
  return v.short || v.name;
}

export function regionLabel(region: string | undefined): string {
  return (region && REGION_LABEL[region]) || "—";
}

export function venuePlace(group: string | undefined): VenuePlace | undefined {
  return group ? VENUE_PLACES[group] : undefined;
}

/** Google Maps 检索链接 —— 用**地址查询**而非坐标(坐标无从核实,交给 Google 自行解析更稳)。
 *  移动端打开会自动唤起已安装的 Google Maps App,否则回落到网页版。
 *  ⚠ 链接模板只此一处:场地卡片与「吃喝」店卡都从这里取,别在页面里另拼一份 query 串。 */
export function mapsUrlForQuery(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function mapsUrl(place: VenuePlace): string {
  return mapsUrlForQuery(`${place.name} ${place.address}`);
}

/** Naver 地图检索链接 —— 韩国本地店(尤其小馆子)在 Naver 上的收录率明显高于 Google,
 *  所以「吃喝」页除了 Google 还挂这一个;同样是普通 URL,不需要任何 API Key。 */
export function naverMapUrlForQuery(query: string): string {
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}

/** Kakao 地图检索链接 —— 与上同理,给用户第三个选择。 */
export function kakaoMapUrlForQuery(query: string): string {
  return `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
}

export function venueTip(v: Venue): string {
  const lines = [v.name_kr ? `${v.name} · ${v.name_kr}` : v.name];
  lines.push(`分区 — ${GROUP_AREA[v.group] ?? "—"}`);
  const place = venuePlace(v.group);
  if (place) {
    lines.push(`地址 — ${place.address}`);
    lines.push(`${place.addressKr} · ${place.location}`);
  }
  if (v.code) {
    lines.push(`官方影院代码 ${v.code} — 与官方 Ticket Catalogue 对表用`);
  }
  return lines.join("\n");
}
