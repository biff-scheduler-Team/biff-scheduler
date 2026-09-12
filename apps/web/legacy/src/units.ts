// 单元(BIFF section)的「英文 · 中文」对照表。
//
// 为什么需要这张表
// ----------------
// 目录片的 `unit` 来自两条管线:官网 section 名(**英文**,如 `Icons` / `Vision–Korea`)
// 与节目册 xlsx 的单元名(**中文**,如 `主竞赛` / `亚洲电影之窗`)。于是同一份片单里
// 「有的单元印英文、有的印中文」—— 卡片副标题读起来是两套语言,用户看不出
// `Icons` 与 `亚洲电影之窗` 是同一层级的并列单元。
//
// 这里给每个单元补齐另一侧,统一成「**英文 · 中文**」,与片名口径(`util.ts::bilingualTitle`)
// 同一排版。展示侧一律走 `util.ts::unitLabel()`(它负责拼接与兜底),本文件只提供数据。
//
// 口径与来源
// ----------
// · 英文侧 = **官网 section 名**(权威来源:`tools/build_films_2026.py::WEB_UNIT`,
//   即官网排期页 / 片目页印的 section 名)。
// · 中文侧 = 节目册 / 官网中文口径。
// · ⚠ 官网只给英文的那几个单元(Icons / World Cinema / Flash Forward / Vision / Open Cinema /
//   Midnight Passion / On Screen / Gala Presentation / CARTE BLANCHE)的中文是**通用译名**,
//   非官方措辞;若官方日后给出中文,以官方为准直接改本表。
// · 表的键 = 数据里**实际出现的 `unit` 原串**(目录管线确定性产出)。换届 / 换版后若出现新单元,
//   按同一格式补一行即可;查不到的原样返回(`util.ts::unitLabel` 的兜底),
//   故**漏行只会少一次对照,不会让单元消失**。

export interface UnitDef {
  /** 官网 section 英文名 */
  en: string;
  /** 中文单元名 */
  zh: string;
}

/** 数据里实际出现的 `unit` 原串 → 双语两侧。 */
const UNIT_DEFS: Record<string, UnitDef> = {
  // ---- 官网英文 section 名(中文侧为通用译名,见文件头)----
  Icons: { en: "Icons", zh: "标志性影人" },
  "World Cinema": { en: "World Cinema", zh: "世界电影" },
  "Flash Forward": { en: "Flash Forward", zh: "新锐导演" },
  Vision: { en: "Vision", zh: "视界" },
  "Vision–Korea": { en: "Vision – Korea", zh: "视界 · 韩国" },
  "Vision–Asia": { en: "Vision – Asia", zh: "视界 · 亚洲" },
  "Midnight Passion": { en: "Midnight Passion", zh: "午夜激情" },
  "Open Cinema": { en: "Open Cinema", zh: "露天影院" },
  "Gala Presentation": { en: "Gala Presentation", zh: "盛典展映" },
  "Korean Cinema Today": { en: "Korean Cinema Today", zh: "今日韩国电影" },
  "Korean Cinema Today – Panorama": { en: "Korean Cinema Today – Panorama", zh: "今日韩国电影 · 全景" },
  "Korean Cinema Today – Special Premiere": {
    en: "Korean Cinema Today – Special Premiere",
    zh: "今日韩国电影 · 特别首映",
  },
  "On Screen": { en: "On Screen", zh: "荧幕单元" },
  "On Screen 单元3部·均为剧集首映": { en: "On Screen", zh: "荧幕单元 · 剧集首映" },
  "CARTE BLANCHE": { en: "CARTE BLANCHE", zh: "自由选片" },
  "CARTE BLANCHE特别企划 自主选择/嘉宾选片": { en: "CARTE BLANCHE", zh: "自由选片 · 自主选择 / 嘉宾选片" },

  // ---- 节目册 / 官网中文单元名(英文侧 = 官网 section 名)----
  亚洲电影之窗: { en: "A Window on Asian Cinema", zh: "亚洲电影之窗" },
  主竞赛: { en: "Competition", zh: "主竞赛" },
  广角镜: { en: "Wide Angle", zh: "广角镜" },
  "广角镜 - 亚洲短片竞赛": { en: "Wide Angle – Asian Short Film Competition", zh: "广角镜 · 亚洲短片竞赛" },
  "广角镜 - 纪录片放映": { en: "Wide Angle – Documentary Showcase", zh: "广角镜 · 纪录片放映" },
  "广角镜 - 纪录片竞赛": { en: "Wide Angle – Documentary Competition", zh: "广角镜 · 纪录片竞赛" },
  特别企划: { en: "Special Program in Focus", zh: "特别企划" },
  "特别企划单元美好的时代: 安圣基": {
    en: "Special Program in Focus – The Good Times: Ahn Sung-ki",
    zh: "特别企划 · 美好的时代: 安圣基",
  },
  特别放映: { en: "Special Screenings", zh: "特别放映" },
  开幕影片: { en: "Opening Film", zh: "开幕影片" },
  日本动画特别企划: { en: "Japanese Animation Special", zh: "日本动画特别企划" },
  亚洲电影人奖: { en: "Asian Filmmaker of the Year", zh: "年度亚洲电影人奖" },
  "年度亚洲电影人奖-杨紫琼专题": {
    en: "Asian Filmmaker of the Year – Michelle Yeoh",
    zh: "年度亚洲电影人奖 · 杨紫琼专题",
  },
};

/** 归一化:统一破折号(en dash / em dash → `-`)、压平空白 —— 换届后同一单元的细微写法差异仍能命中。 */
function normUnit(s: string): string {
  return s.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

/** 归一化索引:精确键 + 「去掉前导年份」变体(数据里有 `2026年度亚洲电影人奖-…` 这类带年份的脏值)。 */
const UNIT_INDEX = new Map<string, UnitDef>();
for (const [key, def] of Object.entries(UNIT_DEFS)) {
  const k = normUnit(key);
  if (!UNIT_INDEX.has(k)) UNIT_INDEX.set(k, def);
  const noYear = k.replace(/^(19|20)\d{2}/, "");
  if (noYear !== k && !UNIT_INDEX.has(noYear)) UNIT_INDEX.set(noYear, def);
}

/** 查单元的「英文 / 中文」两侧;查不到返回 `null`(调用方原样展示)。 */
export function unitDef(raw: string | null | undefined): UnitDef | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const key = normUnit(t);
  return UNIT_INDEX.get(key) ?? UNIT_INDEX.get(key.replace(/^(19|20)\d{2}/, "")) ?? null;
}
