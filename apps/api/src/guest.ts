import type { GuestResult, GuestScreening } from "@biff/contracts/guest";
import { z } from "zod";

const API = "https://filmapi.maketicket.co.kr/api/v1/";
export const guestDate = z.iso.date();
const record = z.record(z.string(), z.unknown());
const text = (value: unknown) => typeof value === "string" ? value : "";
const identifier = (value: unknown) => typeof value === "number" || typeof value === "string" ? String(value) : "";

/** 官方日期带星期文本；只提取日期，时刻允许 24+，不截断午夜场。 */
export function guestScreening(value: unknown, date: string, now: number): GuestScreening | null {
  const parsed = record.safeParse(value);
  if (!parsed.success) return null;
  const item = parsed.data;
  const digits = text(item.sdDate).replace(/\D/g, "").slice(0, 8);
  const code = identifier(item.sdCode);
  const filmId = identifier(item.prodSeq);
  const time = text(item.sdTime).replace(/:/g, "");
  if (digits !== date.replace(/-/g, "") || !/^\d{3,4}$/.test(code) || !/^\d+$/.test(filmId) || !/^\d{4}(\d{2})?$/.test(time)) return null;
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4) || "0");
  if (hour > 47 || minute > 59 || second > 59) return null;
  const starts = Date.parse(`${date}T00:00:00+09:00`) + ((hour * 60 + minute) * 60 + second) * 1000;
  const raw = item.remainSeat;
  const numeric = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  const remaining = Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
  const ended = starts <= now || ["SALEEND", "SALECANCEL"].includes(text(item.saleStatusCd));
  const status = ended ? "ended"
    : item.saleStatusCd === "SOLDOUT" || remaining === 0 ? "sold_out"
    : remaining === null ? "unknown"
    : item.saleStatus === "ING" ? "available" : "not_open";
  return {
    code, filmId, title: text(item.perfMainNm), date,
    time: `${time.slice(0, 2)}:${time.slice(2, 4)}`,
    venue: text(item.venueNm), hall: text(item.hallNm), remaining, status,
  };
}

/** 仅允许固定官方只读端点；不转发访问者 Cookie，也不跟随跳转到其它主机。 */
async function official(path: string, params: Record<string, string>, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const url = new URL(path, API);
  url.search = new URLSearchParams({ chnlCd: "GUEST", partnerId: "BIFF", ...params }).toString();
  const response = await fetcher(url.toString(), {
    headers: { Accept: "application/json", Referer: "https://biff.maketicket.co.kr/" },
    redirect: "error", signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("GUEST_UPSTREAM_FAILED");
  const data = record.parse(await response.json());
  if (data.resultCode !== undefined && data.resultCode !== "0000") throw new Error("GUEST_UPSTREAM_FAILED");
  return data;
}

export async function readGuest(date: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<GuestResult> {
  guestDate.parse(date);
  const dates = await official("rsAvailDateList", {}, fetcher);
  const entries = z.array(z.object({ sdStartDt: z.string() })).parse(dates.dateList);
  const availableDates = [...new Set(entries.map((item) => {
    const raw = item.sdStartDt;
    return guestDate.parse(/^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw);
  }))].sort();
  const dateOpen = availableDates.includes(date);
  let screenings: GuestScreening[] = [];
  if (dateOpen) {
    const listing = await official("prodList", { langCd: "en", perfDate: date.replace(/-/g, "") }, fetcher);
    const rows = z.array(z.unknown()).parse(listing.prodList);
    screenings = rows.map((item) => guestScreening(item, date, now))
      .filter((item): item is GuestScreening => item !== null)
      .sort((a, b) => a.time.localeCompare(b.time) || a.code.localeCompare(b.code));
    // 非空但不可解释的列表属于查询失败，不能伪装成当天没有场次。
    if (rows.length && !screenings.length) throw new Error("GUEST_UPSTREAM_FAILED");
  }
  return { date, availableDates, dateOpen, checkedAt: new Date().toISOString(), screenings };
}
