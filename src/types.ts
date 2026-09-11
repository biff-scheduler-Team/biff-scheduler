// 领域类型 — 与 schedule.json / venues.json / D1 对齐

export type RatingKey = "ALL" | "12" | "15" | "19"; // 观影年龄分级(2025 官方口径,2026 同制)
export type SubsKey = "KE" | "KN" | "KK" | "NO"; // 字幕/对白标识(缺省 = 未标注:英字 + 韩语对白)
export interface Screening {
  code: string;
  title_en: string;
  title_kr: string;
  title_zh: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM KST（当日,恒 < 24:00）
  /**
   * HH:MM KST（GV 已含映后谈时长）。**24+ 时制**:跨午夜场保留 ≥24 的小时 ——
   * 如 `23:59` 开场、次日 05:35 散场 → `"29:35"`。前端全部算术(轴界 / 卡片宽度 / 排序 /
   * 整点筛选 / 冲突 / ICS 进位)都依赖 `end > start`;显示一律走 `fmtEndClock` / `fmtMinRange`。
   * `data.ts::loadCatalog` 是唯一归一化闸门(见该处注释)。
   */
  end_time: string;
  duration_min: number;
  venue_id: string;
  venue_display: string;
  is_gv: boolean;
  /** 场次特性标签(16-F):如 "masterclass" / "premiere" / "open_talk";is_gv 等价于隐含 "gv" */
  tags?: string[];
  /** 观影等级 ALL/12/15/19;缺省不展示(官方每场必有,导入管线保证) */
  rating?: RatingKey;
  /**
   * 字幕/对白标识;**官方 META 会同时印多个**(实测 `KE KK`,2025 版 4 场)。
   * 缺省 = 未标注(英字 + 韩语对白)。
   */
  subs?: SubsKey[];
  /** 官方 Ticket Catalogue 节目册页码(翻册对表用) */
  page?: number;
  /**
   * 午夜场「联映块」成员片名 —— **仅联映块场次有**(2025 版 4 条:008 / 081 / 164 / 244)。
   * 块场次 = 「一张票连看 2–3 部」,格子只印块名(`Midnight Passion N`),块内成员片名
   * 另见单元扉页对照表,由 `extract_schedule.py::parse_midnight_blocks()` 抽出。
   * 成员片的介绍页会把所属块 CODE 列为自己的一场 → 该片场次列表里会出现这条块场次。
   */
  midnight_members?: string[];
}

export interface ScheduleFile {
  festival: {
    name: string;
    year: number;
    dates: string[];
    note?: string;
    generated_at?: string;
  };
  screenings: Screening[];
}

export interface Venue {
  /** 按「厅」建 id = 官方影院代码小写(如 b1 / c2 / l10);一处放映厅一个 id */
  id: string;
  name: string;
  name_kr: string;
  /**
   * 短名 —— **甘特图粘性影厅列的行标签**。列宽 148px,减去内边距 20px + 代码 chip ≈ 25~30px + gap 5px,
   * 留给名字只有 ≈ 98~103px(12px semibold),而全名「Busan Cinema Center Cinema 1」约 178px
   * 必被 `truncate` 裁掉 —— 且区分性字词全在末尾(Cinema 1 / Cinema 2 / Cinematheque),裁完三行一模一样。
   * 故 short 取「**品牌 + 厅号**」并去掉与品牌重复的城市词(`CGV 1` / `LOTTE 10` / `MEGABOX 1` /
   * `BCC Cinematek`);实测 29 条全部 ≤ 98px、零截断。**取用一律走 `legend.ts::venueShort()`**
   * (带 `name` 兜底);全名只出现在 hover tooltip / ⓘ 说明弹层 / ICS LOCATION。可选 → 旧 JSON 仍合法。
   */
  short?: string;
  /** 影院(bcc / cgv / lotte / kofic / megabox / sohyang / bcm)—— 图例「分区」列按它聚合 */
  group: string;
  /** 分区:centum(CENTUM 主场区)/ nampo(南浦洞)。跨区连场需留足转场缓冲 */
  region?: string;
  lat?: number;
  lng?: number;
  /** 官方日程表影院代码(如 B1 / C1 / L2)—— 与官方 Catalogue 对表用 */
  code?: string;
}

export interface VenuesFile {
  venues: Venue[];
}

/** 影片目录(来自用户提供的影片信息表,先只接片名与元信息) */
export interface FilmItem {
  id: string; // f001…,目录序号
  /** **官网英文片名** —— 与 `Screening.title_en` 同源,是排期与片单之间的**唯一身份**。
   *  目录已改为由官网片目生成(见 tools/build_films_2026.py),故这一列必然存在;
   *  匹配一律优先走它,中文名 / 原始片名只作兜底。 */
  title_en?: string;
  unit: string; // 单元:主竞赛 / Icons / 亚洲电影之窗 …
  remark: string; // 备注:世界首映 …
  title_zh: string;
  title_orig: string; // 原始片名(英/日/韩,可能与排期 title_en 不同)
  year: number | null;
  rating: number | null;
  rating_count: number | null;
  country: string;
  director: string;
  /** 海报(相对站点根的路径,如 `/posters/36990574-m.jpg`)—— 由 `tools/build_films.py`
   *  按豆瓣 subject_id 对齐 `public/posters/` 里**已下载**的档位。缺图是常态(250 部里 174 部有),
   *  前端按「无海报」渲染,**不给豆瓣外链兜底**(豆瓣图床有 Referer 防盗链,外链必 418 破图)。 */
  poster?: string;
  /** **仅合集成员**:该片没有独立场次,只在某个合集块(Asian / Korean Short Film
   *  Competition、Midnight Passion 等)里放映 —— 值是块场次的 code。前端据此把它
   *  挂到那一场上,显示「收录于合集 XXX」,而不是「暂无排期」。 */
  block_code?: string;
}

export interface FilmsFile {
  generated_at?: string;
  source?: string;
  films: FilmItem[];
}

/** 一条已选场次:选的是哪一场。
 *  ⚠ 历史:2026-09-11 起**方案(A/B)已整体移除**(`PLAN-20260911190000` D7),
 *  旧 localStorage 里的 `group` 字段读取时被忽略(`state.ts::hydrate`),所有场次同处一套。 */
export interface PickSlot {
  code: string;
}

/** 选片记录 —— 全站唯一数据源(「我的选片」按片看 / 「我的行程」按场次看,都是它的视图)。
 *  键 = filmNodeKey(`cat:<目录 id>` | `sched:<片名小写>`),一部片一条记录:
 *  ① 已选场次挂在 picks 里(可空 = 已选中但未排场);
 *  ② 从行程里移除某一场只动 picks,记录保留(选片意向不丢)。
 *  ⚠ **档位(必看 / 备选 / 随缘)已于 2026-09-11 整体删除**(`PLAN-20260911223000`):
 *    它在冲突场景里的作用被「拖动顺位」完全取代(见 `plans.ts`),在非冲突场景里只是排序噪声。
 *    旧数据里的 `priority` 字段读取时被忽略 —— 零迁移。 */
export interface PickEntry {
  key: string;
  picks: PickSlot[];
  note: string;
}

export interface Mapping {
  code: string;
  subject_id: number | null;
  title_cn: string | null;
  douban_url: string | null;
}

/** 外观偏好:三态 —— 跟随系统 / 亮色(普通)/ 暗色。
 *  CSS 只认 `<html data-theme>`,解析与持久化见 `theme.ts`。 */
export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  alarmMin: number; // .ics 提醒提前量（默认 45）
  transitMin: number; // 跨影院转场缓冲（默认 0，M3 按场馆对覆盖）
  /** GV 映后谈全局默认是否参加(true=含,false=放弃);仅对未单场覆写的场生效。默认 true。 */
  gvTalkOn: boolean;
  /** GV 映后谈默认时长(分钟)。**单场覆写 `store.gvTalkMinOv[code]` 优先**,缺省用本值;默认 25。
   *  仅 `is_gv` 场次生效;0 = 不拆映后段。口径见 `gv.ts` 文件头(时长可配置,不再从数据推导)。 */
  gvTalkMin: number;
  /** 外观偏好(未设过 = 跟随系统)。顶栏「外观」按钮三态循环,见 `theme.ts`。 */
  theme?: ThemePref;
  /** 甘特**整体等比**缩放倍率(1 = 100%,基准行高 92px = `grid.ts::ROW_H`;阶梯 0.55 / 0.7 / 0.9 / 1 / 1.2)。
   *  横向时间刻度与纵向行高共用它,卡片内字号 / 留白 / 徽章行也按同一倍率线性缩。
   *  视图偏好:随设置持久化,但不出现在设置弹层。
   *  ⚠ 旧版这个字段存的是**横向**刻度倍率(0.35~3)或旧行高倍率,读取时由 `clampZoom` 钳进新阶梯 —— 无需迁移。 */
  zoom?: number;
}

export interface Catalog {
  schedule: ScheduleFile;
  dates: string[];
  venues: Venue[];
  venueById: Map<string, Venue>;
  byCode: Map<string, Screening>;
  films: FilmItem[]; // 影片目录(由官网片目生成,见 tools/build_films_2026.py)
  /** 目录索引:**官网英文片名 → 条目** —— 排期与片单的唯一身份口径(命中优先级最高)。 */
  filmByEn: Map<string, FilmItem>;
  /** 目录索引:目录中文名(无中文名则原始片名)→ 条目。`filmNodeKey` / `filmInfoOf` 的命中口径① */
  filmByZh: Map<string, FilmItem[]>;
  /** 目录索引:原始片名 → 条目。命中口径②(原始片名 == 排期英文名) */
  filmByOrig: Map<string, FilmItem[]>;
}
