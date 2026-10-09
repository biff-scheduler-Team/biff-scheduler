import type { GuestResult, TicketSnapshotInfo } from "@biff/contracts/guest";
import { KST_OFFSET_MS, kstDay, kstDayMinus } from "./day";
import { readTicketDate, readTicketDates } from "./guest";

type Channel = "GUEST" | "WEB";
interface SnapshotRow {
  id: string;
  channel: Channel;
  date: string;
  captured_at: number;
  source: "scheduled" | "manual";
  status: "ok" | "error";
  payload: string | null;
  error: string | null;
}

export const guestQueryDates = (at: number) => [kstDay(at), kstDayMinus(-1, at)];

/** 08:30 也采集一次；其后从 08:35 恢复五分钟周期。 */
export function ticketCollectionDue(at: number): boolean {
  const clock = new Date(at + KST_OFFSET_MS);
  return clock.getUTCMinutes() % 5 === 0 || (clock.getUTCHours() === 8 && clock.getUTCMinutes() <= 30);
}

function info(row: SnapshotRow): TicketSnapshotInfo {
  return { id: row.id, capturedAt: new Date(row.captured_at).toISOString(), source: row.source, status: row.status };
}

export function snapshotResult(row: SnapshotRow): GuestResult | null {
  if (!row.payload || row.status === "error") return null;
  return { ...JSON.parse(row.payload) as GuestResult, snapshot: info(row) };
}

export async function findTicketSnapshot(db: D1Database, channel: Channel, date: string): Promise<SnapshotRow | null> {
  const query = db.prepare("SELECT * FROM ticket_snapshot WHERE channel = ? AND date = ? ORDER BY captured_at DESC, id DESC LIMIT 1").bind(channel, date);
  return (await query.all<SnapshotRow>()).results[0] ?? null;
}

async function save(db: D1Database, channel: Channel, date: string, result: GuestResult | null, scheduledAt?: number): Promise<SnapshotRow> {
  const row: SnapshotRow = {
    id: crypto.randomUUID(), channel, date, captured_at: Date.now(),
    source: scheduledAt === undefined ? "manual" : "scheduled", status: result ? "ok" : "error",
    payload: result ? JSON.stringify(result) : null, error: result ? null : `${channel === "GUEST" ? "GUEST" : "GENERAL"}_UPSTREAM_FAILED`,
  };
  // 必须等落库成功才宣告查询成功；数据库故障不可伪装成上游失败或已保存。
  await db.prepare("INSERT INTO ticket_snapshot (id, channel, date, captured_at, scheduled_at, source, status, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, channel, date, row.captured_at, scheduledAt ?? null, row.source, row.status, row.payload, row.error).run();
  return row;
}

export async function captureTicketDate(db: D1Database, channel: Channel, date: string, options: {
  fetcher?: typeof fetch; dates?: string[]; scheduledAt?: number; now?: number;
} = {}): Promise<SnapshotRow> {
  const now = options.now ?? Date.now();
  let result: GuestResult | null = null;
  try {
    const dates = options.dates ?? await readTicketDates(channel, options.fetcher);
    result = await readTicketDate(date, channel, dates, options.fetcher, now);
    result.queryDates = channel === "GUEST" ? guestQueryDates(now) : dates;
  } catch {
    // 上游失败同样是一次观察结果；不能用上一次成功的库存冒充当前库存。
  }
  return save(db, channel, date, result, options.scheduledAt);
}

/** 独立于网页的定时采集；每渠道先发现日期，再以最多两个并发读取当日库存。 */
export async function collectTicketSnapshots(db: D1Database, scheduledTime: number, fetcher: typeof fetch = fetch): Promise<void> {
  if (!ticketCollectionDue(scheduledTime)) return;
  const scheduledAt = Math.floor(scheduledTime / 60_000) * 60_000;
  const startedAt = Date.now();
  const claim = await db.prepare(`INSERT INTO ticket_collection_run (scheduled_at, started_at) VALUES (?, ?)
    ON CONFLICT(scheduled_at) DO UPDATE SET started_at = excluded.started_at
    WHERE ticket_collection_run.finished_at IS NULL AND ticket_collection_run.started_at < ?`)
    .bind(scheduledAt, startedAt, startedAt - 5 * 60_000).run();
  if (!claim.meta.changes) return;
  for (const channel of ["GUEST", "WEB"] as const) {
    let dates: string[];
    try {
      dates = await readTicketDates(channel, fetcher);
    } catch {
      const failedDates = channel === "GUEST" ? guestQueryDates(scheduledAt) : [""];
      for (const date of failedDates) {
        const exists = await db.prepare("SELECT id FROM ticket_snapshot WHERE channel = ? AND date = ? AND scheduled_at = ?")
          .bind(channel, date, scheduledAt).all();
        if (!exists.results.length) await save(db, channel, date, null, scheduledAt);
      }
      continue;
    }
    const targets = channel === "GUEST" ? guestQueryDates(scheduledAt) : dates;
    if (!targets.length) {
      const exists = await db.prepare("SELECT id FROM ticket_snapshot WHERE channel = ? AND date = '' AND scheduled_at = ?")
        .bind(channel, scheduledAt).all();
      if (!exists.results.length) await save(db, channel, "", {
        date: kstDay(scheduledAt), availableDates: [], queryDates: [], dateOpen: false,
        checkedAt: new Date().toISOString(), screenings: [],
      }, scheduledAt);
    }
    for (let i = 0; i < targets.length; i += 2) {
      await Promise.all(targets.slice(i, i + 2).map(async (date) => {
        const exists = await db.prepare("SELECT id FROM ticket_snapshot WHERE channel = ? AND date = ? AND scheduled_at = ?")
          .bind(channel, date, scheduledAt).all();
        if (!exists.results.length) await captureTicketDate(db, channel, date, { dates, fetcher, scheduledAt });
      }));
    }
  }
  await db.prepare("UPDATE ticket_collection_run SET finished_at = ? WHERE scheduled_at = ? AND started_at = ?")
    .bind(Date.now(), scheduledAt, startedAt).run();
  console.log(JSON.stringify({ event: "ticket_snapshots_collected", scheduledAt }));
}
