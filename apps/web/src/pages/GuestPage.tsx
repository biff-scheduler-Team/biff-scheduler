import { GUEST_NOTE, GUEST_STATUS_LABELS, type GuestResult } from "@biff/contracts/guest";
import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router";
import { api, ApiFailure } from "../account-sync";
import { useCatalog } from "../app/store";
import { ActionButton, Checkbox, SearchField } from "../components/spectrum";
import { ScreeningCard } from "../components/ScreeningCard";
import { filmInfoOf, filmNodeKey } from "../util";
import { wantCountLabel } from "../actions-copy";
import { hasWantCounts, loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";
import "./guest.css";

export function GuestPage() {
  return <TicketAvailabilityPage channel="guest" />;
}

export function GeneralPage() {
  return <TicketAvailabilityPage channel="general" />;
}

function TicketAvailabilityPage({ channel }: { channel: "guest" | "general" }) {
  const label = channel === "guest" ? "GUEST" : "普通票";
  const { cat } = useCatalog();
  const [date, setDate] = useState("");
  const [request, setRequest] = useState({ revision: 0, force: false });
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [result, setResult] = useState<GuestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [wantCounts, setWantCounts] = useState(peekWantCounts);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86_400_000));
  const selectedDate = date || today;

  useEffect(() => {
    // 浏览器只轮询已保存结果；真实官方采集由服务端 cron 独立完成。
    const timer = setInterval(() => setRequest((current) => ({ revision: current.revision + 1, force: false })), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (channel === "guest" && date && date !== today && date !== tomorrow) setDate("");
  }, [channel, date, today, tomorrow]);

  useEffect(() => {
    let active = true;
    void loadWantCounts().then((counts) => { if (active) setWantCounts({ ...counts }); });
    const stop = onWantCountsChange(() => setWantCounts({ ...peekWantCounts() }));
    return () => { active = false; stop(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let active = true;
    setLoading(true);
    setResult(null);
    setError("");
    void (async () => {
      try {
        const params = new URLSearchParams({ date: selectedDate });
        if (request.force) params.set("refresh", "1");
        const response = await api(`/api/${channel}?${params}`, { signal: controller.signal });
        const data = await response.json() as GuestResult;
        if (active) setResult(data);
      } catch (cause) {
        if (active) setError(cause instanceof ApiFailure && cause.status === 429
          ? "查询太频繁，请稍后刷新。" : `${label} 查询失败，余量未知。请稍后刷新重试。`);
      } finally {
        clearTimeout(timeout);
        if (active) setLoading(false);
      }
    })();
    // 切换日期或离开页面后，旧请求不能覆盖新日期的数据。
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [channel, label, selectedDate, request]);

  const needle = query.trim().toLocaleLowerCase();
  const rows = (result?.screenings ?? []).map((row) => {
    const screening = cat.byCode.get(row.code);
    // 仅在日期和时刻也匹配时使用本地双语片名，避免同编号跨届或跨日误配。
    const matched = screening && screening.date === row.date && screening.start_time.slice(0, 5) === row.time ? screening : undefined;
    const title = matched ? filmInfoOf(cat, matched).title : row.title;
    const wantCount = matched && hasWantCounts() ? wantCounts[filmNodeKey(cat, matched)] ?? 0 : null;
    return { ...row, title, screening: matched, wantCount };
  }).filter((row) => (!onlyAvailable || row.status === "available") &&
    (!needle || [row.title, row.code, row.filmId, row.venue, row.hall].join(" ").toLocaleLowerCase().includes(needle)));

  return (
    <section className="panel guest-page" aria-labelledby="guest-heading">
      <div className="panel-heading">
        <div><h1 id="guest-heading">{label} 查票</h1><p>官方{channel === "guest" ? "嘉宾" : "普通票 WEB"}渠道余票 · 韩国时间</p></div>
        <ActionButton isDisabled={loading} onPress={() => setRequest((current) => ({ revision: current.revision + 1, force: true }))}>刷新余票</ActionButton>
      </div>
      <nav aria-label="查票渠道"><Link to="/general">普通票查票</Link>{" · "}<Link to="/guest">GUEST 查票</Link></nav>
      <p className="guest-note">{channel === "guest" ? `${GUEST_NOTE} 场次卡中的票价为普通票价，不代表嘉宾换票费用。` : "官方 WEB 普通票列表余量，仅供查询；不锁座、不创建订单。列表有票不代表具体座位已核验，实际余票与票价以官方购票页为准。"}</p>
      <p className="guest-note">后台每 5 分钟采集并保存快照；韩国时间 08:00–08:30 每分钟采集。{channel === "guest" ? "GUEST 查询当天和次日。" : "普通票采集官方全部开放日期。"}</p>
      <div className="guest-controls">
        <label className="guest-date">查询日期<input type="date" value={selectedDate} min={channel === "guest" ? today : undefined} max={channel === "guest" ? tomorrow : undefined} onChange={(event) => { setDate(event.target.value); setRequest((current) => ({ revision: current.revision + 1, force: false })); }} /></label>
        <SearchField label="片名、场次编号或影片 ID" value={query} onChange={setQuery} />
        <Checkbox isSelected={onlyAvailable} onChange={setOnlyAvailable}>只看有票</Checkbox>
      </div>
      {(result || channel === "guest") && <div className="guest-dates" aria-label="查询日期快捷选项">
        <span>{channel === "guest" ? "查询日期：" : "开放日期："}</span>
        {(channel === "guest" ? [today, tomorrow] : result?.queryDates ?? result?.availableDates ?? []).map((day) =>
          <ActionButton key={day} isDisabled={day === selectedDate} onPress={() => { setDate(day); setRequest((current) => ({ revision: current.revision + 1, force: false })); }}>{day}</ActionButton>)}
      </div>}
      <div role="status" aria-live="polite" className="guest-summary">
        {loading ? `正在查询 ${label} 余票…` : result ? `${rows.length} 场 · ${result.date} · ${new Date(result.checkedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Seoul", hour12: false })} 更新` : ""}
      </div>
      {error && <p role="alert">{error}</p>}
      {result?.snapshot && <p className="guest-note">已保存 · {result.snapshot.source === "scheduled" ? "后台定时采集" : "手动查询"} · {new Date(result.snapshot.capturedAt).toLocaleString("zh-CN", { timeZone: "Asia/Seoul", hour12: false })}</p>}
      {result && Date.now() - Date.parse(result.checkedAt) > 6 * 60_000 && <p role="alert">当前显示较早的快照，可能不是最新余票，请刷新查询。</p>}
      {result && !result.dateOpen && <p className="empty-state">该日期 {label} 尚未开放查询，余量未知。</p>}
      {result?.dateOpen && !rows.length && <p className="empty-state">没有符合筛选条件的 {label} 场次。</p>}
      {rows.length > 0 && <ul className="guest-list" aria-label={`${label} 场次`}>
        {rows.map((row) => <li key={`${row.date}-${row.code}`} data-guest-code={channel === "guest" ? row.code : undefined} data-general-code={channel === "general" ? row.code : undefined}>
          <div className="guest-stock"><strong>{label} {row.remaining === null ? "余量未知" : `${row.remaining} 张`}</strong><span>{GUEST_STATUS_LABELS[row.status]}</span>
            <span className="want-count" data-want-count={row.wantCount ?? undefined} title="本站影片级想看人数，不是该场购票人数">{row.wantCount === null ? "想看人数未知" : wantCountLabel(row.wantCount)}</span>
          </div>
          {row.screening ? <ScreeningCard screening={row.screening} pickable={false} /> :
            <div className="guest-unmatched"><h3>{row.title || "片名未知"}</h3><p>{row.time} · #{row.code} · {row.venue} · {row.hall}</p><p>本地目录未匹配到该场次，显示官方信息。</p></div>}
          <small className="guest-film-id">官方影片 ID {row.filmId}</small>
        </li>)}
      </ul>}
      <Outlet />
    </section>
  );
}
