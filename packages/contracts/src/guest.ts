export type GuestStatus = "available" | "sold_out" | "not_open" | "ended" | "unknown";

export interface GuestScreening {
  code: string;
  filmId: string;
  title: string;
  date: string;
  time: string;
  venue: string;
  hall: string;
  remaining: number | null;
  status: GuestStatus;
}

export interface GuestResult {
  date: string;
  availableDates: string[];
  dateOpen: boolean;
  checkedAt: string;
  screenings: GuestScreening[];
  queryDates?: string[];
  snapshot?: TicketSnapshotInfo;
}

export interface TicketSnapshotInfo {
  id: string;
  capturedAt: string;
  source: "scheduled" | "manual";
  status: "ok" | "error";
}

export const GUEST_NOTE = "GUEST 为官方嘉宾渠道参考余量，尚未确认学生 Cinephile badge 共用此配额；需线下换票。";
export const GUEST_STATUS_LABELS: Record<GuestStatus, string> = {
  available: "有票", sold_out: "售罄", not_open: "未开放", ended: "已结束", unknown: "余量未知",
};
