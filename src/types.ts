// 领域类型 — 与 schedule.json / venues.json / D1 对齐

export type RatingKey = "ALL" | "12" | "15" | "19"; // 观影年龄分级(2025 官方口径,2026 同制)
export type SubsKey = "KE" | "KN" | "KK" | "NO"; // 字幕/对白标识(缺省 = 未标注:英字 + 韩语对白)

export interface Screening {
  code: string;
  title_en: string;
  title_kr: string;
  title_zh: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM KST
  end_time: string; // HH:MM KST（GV 已含 +25min）
  duration_min: number;
  venue_id: string;
  venue_display: string;
  is_gv: boolean;
  /** 场次特性标签(16-F):如 "masterclass" / "premiere" / "open_talk";is_gv 等价于隐含 "gv" */
  tags?: string[];
  /** 观影等级 ALL/12/15/19;缺省不展示(官方每场必有,导入管线保证) */
  rating?: RatingKey;
  /** 字幕/对白标识;缺省 = 未标注(英字 + 韩语对白) */
  subs?: SubsKey;
  /** 官方 Ticket Catalogue 节目册页码(翻册对表用) */
  page?: number;
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
  id: string;
  name: string;
  name_kr: string;
  group: string;
  lat?: number;
  lng?: number;
  /** 官方日程表影院代码(如 B1 / C1 / L2);2025 口径演示,2026 以官网为准 */
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

export interface PlanEntry {
  code: string;
  group: Group;
  priority: Priority;
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
}

export interface Catalog {
  schedule: ScheduleFile;
  dates: string[];
  venues: Venue[];
  venueById: Map<string, Venue>;
  byCode: Map<string, Screening>;
  films: FilmItem[]; // 影片目录(可先于排期发布,按 id 与排期 title 关联)
}

export const GROUP_LABEL: Record<Group, string> = { A: "A", B: "B" };
export const PRIORITY_LABEL: Record<Priority, string> = {
  must: "必看",
  maybe: "备选",
  wild: "随缘",
};
