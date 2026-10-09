import { GUEST_NOTE, GUEST_STATUS_LABELS, type GuestResult } from "@biff/contracts/guest";
import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import { api, ApiFailure } from "../account-sync";
import { useCatalog } from "../app/store";
import { ActionButton, Checkbox, SearchField } from "../components/spectrum";
import { ScreeningCard } from "../components/ScreeningCard";
import { filmInfoOf } from "../util";
import "./guest.css";

export function GuestPage() {
  const { cat } = useCatalog();
  const [date, setDate] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [result, setResult] = useState<GuestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let active = true;
    setLoading(true);
    setResult(null);
    setError("");
    void (async () => {
      try {
        const response = await api(`/api/guest${date ? `?date=${encodeURIComponent(date)}` : ""}`, { signal: controller.signal });
        const data = await response.json() as GuestResult;
        if (active) setResult(data);
      } catch (cause) {
        if (active) setError(cause instanceof ApiFailure && cause.status === 429
          ? "查询太频繁，请稍后刷新。" : "GUEST 查询失败，余量未知。请稍后刷新重试。");
      } finally {
        clearTimeout(timeout);
        if (active) setLoading(false);
      }
    })();
    // 切换日期或离开页面后，旧请求不能覆盖新日期的数据。
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [date, revision]);

  const needle = query.trim().toLocaleLowerCase();
  const rows = (result?.screenings ?? []).map((row) => {
    const screening = cat.byCode.get(row.code);
    // 仅在日期和时刻也匹配时使用本地双语片名，避免同编号跨届或跨日误配。
    const matched = screening && screening.date === row.date && screening.start_time.slice(0, 5) === row.time ? screening : undefined;
    const title = matched ? filmInfoOf(cat, matched).title : row.title;
    return { ...row, title, screening: matched };
  }).filter((row) => (!onlyAvailable || row.status === "available") &&
    (!needle || [row.title, row.code, row.filmId, row.venue, row.hall].join(" ").toLocaleLowerCase().includes(needle)));

  return (
    <section className="panel guest-page" aria-labelledby="guest-heading">
      <div className="panel-heading">
        <div><h1 id="guest-heading">GUEST 查票</h1><p>官方嘉宾渠道余票 · 韩国时间</p></div>
        <ActionButton isDisabled={loading} onPress={() => setRevision((value) => value + 1)}>刷新余票</ActionButton>
      </div>
      <p className="guest-note">{GUEST_NOTE} 场次卡中的票价为普通票价，不代表嘉宾换票费用。</p>
      <div className="guest-controls">
        <label className="guest-date">查询日期<input type="date" value={date || result?.date || ""} onChange={(event) => setDate(event.target.value)} /></label>
        <SearchField label="片名、场次编号或影片 ID" value={query} onChange={setQuery} />
        <Checkbox isSelected={onlyAvailable} onChange={setOnlyAvailable}>只看有票</Checkbox>
      </div>
      {result && <div className="guest-dates" aria-label="官方开放日期">
        <span>开放日期：</span>
        {result.availableDates.length ? result.availableDates.map((day) =>
          <ActionButton key={day} isDisabled={day === result.date} onPress={() => setDate(day)}>{day}</ActionButton>) : <span>暂无</span>}
      </div>}
      <div role="status" aria-live="polite" className="guest-summary">
        {loading ? "正在查询 GUEST 余票…" : result ? `${rows.length} 场 · ${result.date} · ${new Date(result.checkedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Seoul", hour12: false })} 更新` : ""}
      </div>
      {error && <p role="alert">{error}</p>}
      {result && !result.dateOpen && <p className="empty-state">该日期 GUEST 尚未开放查询，余量未知。</p>}
      {result?.dateOpen && !rows.length && <p className="empty-state">没有符合筛选条件的 GUEST 场次。</p>}
      {rows.length > 0 && <ul className="guest-list" aria-label="GUEST 场次">
        {rows.map((row) => <li key={`${row.date}-${row.code}`} data-guest-code={row.code}>
          <div className="guest-stock"><strong>GUEST {row.remaining === null ? "余量未知" : `${row.remaining} 张`}</strong><span>{GUEST_STATUS_LABELS[row.status]}</span></div>
          {row.screening ? <ScreeningCard screening={row.screening} pickable={false} /> :
            <div className="guest-unmatched"><h3>{row.title || "片名未知"}</h3><p>{row.time} · #{row.code} · {row.venue} · {row.hall}</p><p>本地目录未匹配到该场次，显示官方信息。</p></div>}
          <small className="guest-film-id">官方影片 ID {row.filmId}</small>
        </li>)}
      </ul>}
      <Outlet />
    </section>
  );
}
