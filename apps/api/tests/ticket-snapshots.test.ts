import { DatabaseSync } from "node:sqlite";
import snapshotMigration from "../migrations/0016_ticket_snapshots.sql?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createD1 } from "./d1-shim";
import { captureTicketDate, collectTicketSnapshots, findTicketSnapshot, guestQueryDates, snapshotResult, ticketCollectionDue } from "../src/ticket-snapshots";

const at = Date.parse("2026-10-09T08:01:00+09:00");
const json = (body: unknown) => new Response(JSON.stringify(body));
let sqlite: DatabaseSync;
let db: D1Database;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(snapshotMigration);
  db = createD1(sqlite);
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); });

describe("定时查票与不可变快照", () => {
  it.each([["07:59", false], ["08:00", true], ["08:01", true], ["08:29", true], ["08:30", true], ["08:31", false], ["08:35", true], ["12:00", true], ["12:01", false]])("韩国 %s 的采集边界", (time, expected) => {
    expect(ticketCollectionDue(Date.parse(`2026-10-09T${time}:00+09:00`))).toBe(expected);
  });
  it("午夜推进 GUEST 今天和明天，整天应有 312 轮", () => {
    expect(guestQueryDates(Date.parse("2026-10-09T15:00:00Z"))).toEqual(["2026-10-10", "2026-10-11"]);
    const start = Date.parse("2026-10-09T00:00:00+09:00");
    expect(Array.from({ length: 1440 }, (_, m) => ticketCollectionDue(start + m * 60_000)).filter(Boolean)).toHaveLength(312);
  });
  it("每轮 GUEST 两天、WEB 全部日期，重复触发不重复请求，下一轮仍保存相同结果", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("rsAvailDateList")
        ? json({ dateList: ["2026-10-09", "2026-10-10", "2026-10-11"].map(sdStartDt => ({ sdStartDt })) })
        : json({ prodList: [] });
    });
    await collectTicketSnapshots(db, at, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(sqlite.prepare("SELECT channel, date FROM ticket_snapshot ORDER BY channel, date").all()).toEqual([
      { channel: "GUEST", date: "2026-10-09" }, { channel: "GUEST", date: "2026-10-10" },
      { channel: "WEB", date: "2026-10-09" }, { channel: "WEB", date: "2026-10-10" }, { channel: "WEB", date: "2026-10-11" },
    ]);
    const first = await findTicketSnapshot(db, "GUEST", "2026-10-09");
    expect(snapshotResult(first!)).toMatchObject({ snapshot: { source: "scheduled" }, screenings: [] });
    await collectTicketSnapshots(db, at, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(7);
    vi.setSystemTime(at + 60_000);
    await collectTicketSnapshots(db, at + 60_000, fetcher);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ticket_snapshot").get()).toMatchObject({ n: 10 });
    expect((await findTicketSnapshot(db, "GUEST", "2026-10-09"))!.id).not.toBe(first!.id);
  });
  it("一个日期失败不阻断其它日期，未开放与失败分别保存", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("rsAvailDateList")) return json({ dateList: [{ sdStartDt: "2026-10-09" }] });
      if (url.searchParams.get("chnlCd") === "WEB") throw new Error("timeout");
      return json({ prodList: [] });
    });
    await collectTicketSnapshots(db, at, fetcher);
    const closed = await findTicketSnapshot(db, "GUEST", "2026-10-10");
    expect(snapshotResult(closed!)).toMatchObject({ dateOpen: false, screenings: [] });
    const failed = await findTicketSnapshot(db, "WEB", "2026-10-09");
    expect(failed).toMatchObject({ status: "error", payload: null });
    expect(snapshotResult(failed!)).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM ticket_snapshot").get()).toMatchObject({ n: 3 });
  });
  it("日期发现故障同样留痕，且 GUEST 两天各自记录", async () => {
    await collectTicketSnapshots(db, at, vi.fn().mockRejectedValue(new Error("offline")));
    expect(sqlite.prepare("SELECT channel, date, status FROM ticket_snapshot ORDER BY channel, date").all()).toEqual([
      { channel: "GUEST", date: "2026-10-09", status: "error" }, { channel: "GUEST", date: "2026-10-10", status: "error" },
      { channel: "WEB", date: "", status: "error" },
    ]);
  });
  it("手动查询每次保存，不修改上一份快照；最新失败不回退旧成功", async () => {
    const first = await captureTicketDate(db, "WEB", "2026-10-09", { fetcher: vi.fn().mockResolvedValue(json({ dateList: [] })) });
    vi.setSystemTime(at + 1000);
    await captureTicketDate(db, "WEB", "2026-10-09", { fetcher: vi.fn().mockRejectedValue(new Error("failed")) });
    expect(sqlite.prepare("SELECT payload FROM ticket_snapshot WHERE id = ?").get(first.id)).toMatchObject({ payload: first.payload });
    expect((await findTicketSnapshot(db, "WEB", "2026-10-09"))!.status).toBe("error");
  });
  it("非调度分钟不查询或写库，过期未完成租约可重试", async () => {
    const fetcher = vi.fn(async () => json({ dateList: [] }));
    await collectTicketSnapshots(db, Date.parse("2026-10-09T09:01:00+09:00"), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    sqlite.prepare("INSERT INTO ticket_collection_run (scheduled_at, started_at) VALUES (?, ?)").run(at, at - 6 * 60_000);
    await collectTicketSnapshots(db, at, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT finished_at FROM ticket_collection_run").get()).toMatchObject({ finished_at: at });
    expect(sqlite.prepare("SELECT status FROM ticket_snapshot WHERE channel = 'WEB' AND date = ''").get()).toMatchObject({ status: "ok" });
  });
});
