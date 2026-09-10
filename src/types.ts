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
  unit: string; // 单元:主竞赛 / Icons / 亚洲电影之窗 …
  remark: string; // 备注:世界首映 …
  title_zh: string;
  title_orig: string; // 原始片名(英/日/韩,可能与排期 title_en 不同)
  year: number | null;
  rating: number | null;
  rating_count: number | null;
  country: string;
  director: string;
}

export interface FilmsFile {
  generated_at?: string;
  source?: string;
  films: FilmItem[];
}

export type Group = "A" | "B";
export type Priority = "must" | "maybe" | "wild";

/** 一条已选场次:选的是哪一场 + 归属哪个方案。
 *  group 留在场次级(同一部片的两场可以分别放进 A / B 方案),档位则统一在影片级(见 PickEntry)。 */
export interface PickSlot {
  code: string;
  group: Group;
}

/** 选片记录 —— 全站唯一数据源(「我的选片」按片看 / 「我的行程」按场次看,都是它的视图)。
 *  键 = filmNodeKey(`cat:<目录 id>` | `sched:<片名小写>`),一部片一条记录:
 *  ① 档位只有一份且在影片级 —— 行程行改档位 = 改该片档位,两个视图永不打架;
 *  ② 已选场次挂在 picks 里(可空 = 已打标/已选中但未排场);
 *  ③ 从行程里移除某一场只动 picks,记录保留(选片意向不丢)。 */
export interface PickEntry {
  key: string;
  /** null = 未设档位(直接点选场次、影片库没打标 / 用户主动清空);不参与质量分 */
  priority: Priority | null;
  picks: PickSlot[];
  note: string;
}

export interface Mapping {
  code: string;
  subject_id: number | null;
  title_cn: string | null;
  douban_url: string | null;
}

export interface Settings {
  alarmMin: number; // .ics 提醒提前量（默认 45）
  transitMin: number; // 跨影院转场缓冲（默认 0，M3 按场馆对覆盖）
  /** GV 映后谈全局默认是否参加(true=含,false=放弃);仅对未单场覆写的场生效。默认 true。 */
  gvTalkOn: boolean;
  /** GV 映后谈默认时长(分钟)。**单场覆写 `store.gvTalkMinOv[code]` 优先**,缺省用本值;默认 25。
   *  仅 `is_gv` 场次生效;0 = 不拆映后段。口径见 `gv.ts` 文件头(时长可配置,不再从数据推导)。 */
  gvTalkMin: number;
}

export interface Catalog {
  schedule: ScheduleFile;
  dates: string[];
  venues: Venue[];
  venueById: Map<string, Venue>;
  byCode: Map<string, Screening>;
  films: FilmItem[]; // 影片目录(可先于排期发布,按 id 与排期 title 关联)
}
