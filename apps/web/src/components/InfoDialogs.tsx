import { FilmBadge } from "./ScreeningCard";
import { useEffect, useMemo, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  Heading,
  Link,
} from "./spectrum";
import { useCatalog } from "../app/store";
import {
  countdownText,
  extras,
  formatKrw,
  nextTicketOpen,
  ticketOpens,
} from "../extras";
import { buildTicketIcs } from "../ics";
import { download } from "./ExportDialog";
import {
  mapsUrl,
  RATING_DEFS,
  RATING_ORDER,
  regionLabel,
  SUBS_DEFS,
  venuePlace,
  venueShort,
} from "../legend";
import { BADGE_DEFS } from "../badges";
import type { Venue } from "../types";

// Keep the legacy Chinese summaries, matching the source wording rather than its order.
const NOTE_ZH: [RegExp, string][] = [
  [/Chrome/i, "推荐用 Chrome 浏览器购票"],
  [/pop-up/i, "购票页打不开时，检查浏览器「拦截弹窗」设置"],
  [/Multiple sessions|simultaneous logins/i, "同一账号不允许重复登录 / 多设备同时购票"],
  [/tablet/i, "平板设备购票可能异常"],
  [/queue number/i, "高流量时会发排队号依次放行；每场限购 2 张，换场次要重新排队"],
  [/Call Center/i, "查不到订单时打 BIFF 客服 1666-9177"],
];
const SLOT_ZH: Record<string, string> = {
  "Audience Entrance": "观众入场",
  "Red Carpet Event": "红毯",
  "Main event": "主活动",
  "Screening of": "开/闭幕片放映",
};

export function TicketLabel() {
  const { cat } = useCatalog();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const update = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const id = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const next = nextTicketOpen(cat.schedule.festival.year, now);
  const opens = ticketOpens(cat.schedule.festival.year);
  if (!opens.length) return <>购票信息</>;
  if (!next) return <span title="全部批次均已开票，点击查看票价、购票须知与开票批次">BIFF 2026 售票中 · 抢票信息</span>;
  const batch = opens.findIndex((o) => o.at === next.at) + 1;
  const seconds = Math.max(0, Math.ceil((next.at - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const showSeconds = seconds <= 3600;
  const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .slice(0, showSeconds ? 3 : 2)
    .map(n => String(n).padStart(2, "0")).join(":");
  return (
    <span className="ticket-countdown" title={`第 ${batch} 批：北京时间 ${next.bj} / 韩国时间 ${next.kst}\n包含：${next.includes}`}>
      <span className="ticket-countdown-label">距第 {batch} 批开票</span>
      <span role="timer" aria-live="off" aria-label={`${days} 天 ${Math.floor(seconds / 3600) % 24} 小时 ${Math.floor(seconds / 60) % 60} 分${showSeconds ? ` ${seconds % 60} 秒` : ""}`} className="ticket-countdown-digits">
        <span>{days}<small>天</small></span><span>{clock}</span>
      </span>
    </span>
  );
}
export function TicketDialog() {
  const { cat } = useCatalog();
  const data = extras();
  const opens = ticketOpens(cat.schedule.festival.year);
  return (
    <Dialog size="L">
      {({ close }) => {
        // The trigger stays mounted; the dialog body is rendered afresh on open.
        const now = Date.now();
        return (
        <>
          <Heading slot="title">购票信息</Heading>
          <Content>
            {data ? (
              <div className="info-sections">
                <section>
                  <h2>开票时间</h2>
                  {opens.map((o, i) => (
                    <article key={o.at} className="ticket-batch">
                      <h3>第 {i + 1} 批</h3>
                      <p>韩国时间 {o.kst}</p>
                      <p>北京时间 {o.bj}</p>
                      <p>{o.at > now ? `还有 ${countdownText(o.at - now)}` : "已开票"}</p>
                      <p>包含：{o.includes}</p>
                      <p className="muted">官网原文：{o.raw}</p>
                    </article>
                  ))}
                  <p className="muted">官网印的是韩国时间（KST）；北京时间 = KST − 1 小时。高流量时按排队号依次放行。</p>
                  <div className="inline-actions">
                    <Button
                      isDisabled={!opens.length}
                      onPress={() =>
                        download(
                          buildTicketIcs(
                            opens,
                            30,
                            data.ticketing.bookingUrl ?? data.ticketing.url,
                          ),
                          "biff-ticket-reminders.ics",
                          "text/calendar",
                        )
                      }
                    >
                      导出开票提醒
                    </Button>
                    {data.ticketing.bookingUrl && (
                      <Link href={data.ticketing.bookingUrl} target="_blank" rel="noopener noreferrer">
                        在线购票入口
                      </Link>
                    )}
                    <Link
                      href={data.ticketing.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      官方购票说明
                    </Link>
                  </div>
                  <p className="muted">开票日历含提前 30 分钟提醒。</p>
                  {data.ticketing.salesPeriod?.period && (
                    <p>
                      在线售票 {data.ticketing.salesPeriod.period}
                      {data.ticketing.salesPeriod.hours && `（${data.ticketing.salesPeriod.hours}）`}
                      {data.ticketing.salesPeriod.payment && ` · ${data.ticketing.salesPeriod.payment}`}
                    </p>
                  )}
                </section>
                <section>
                  <h2>票价</h2>
                  <dl className="definition-list">
                    {data.ticketing.prices.map((p) => (
                      <div key={p.label}>
                        <dt>{p.label}</dt>
                        <dd>{formatKrw(p.krw)}</dd>
                      </div>
                    ))}
                  </dl>
                  {data.ticketing.discountKrw && (
                    <p>折扣 −{formatKrw(data.ticketing.discountKrw)}：65 岁以上（1961 年及以前出生）/ 残障 / 退伍军人，需证件核验</p>
                  )}
                  {data.ticketing.discounts?.length ? (
                    <details>
                      <summary>折扣适用条件（{data.ticketing.discounts.length} 类，官网原文）</summary>
                      {data.ticketing.discounts.map((d) => (
                        <div key={d.who}>
                          <h3>{d.who}</h3>
                          <ul>
                            {d.terms.map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </details>
                  ) : null}
                </section>
                <section>
                  <h2>购票须知</h2>
                  <ul>
                    {data.ticketing.notes.map((n) => (
                      <li key={n}>{NOTE_ZH.find(([pattern]) => pattern.test(n))?.[1] ?? n}</li>
                    ))}
                  </ul>
                  <p>
                    咨询：{data.ticketing.callCenter}
                    {data.ticketing.email && ` · ${data.ticketing.email}`}
                  </p>
                </section>
                {data.ticketing.refund && (
                  <section>
                    <h2>取消与退款</h2>
                    <p>{data.ticketing.refund.deadline}</p>
                    {data.ticketing.refund.fees.length > 0 && (
                      <dl className="definition-list">
                        {data.ticketing.refund.fees.map((f) => (
                          <div key={f.when}>
                            <dt>{f.when}</dt>
                            <dd>
                              {f.fee}
                              {f.note && <span className="muted"> {f.note}</span>}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {data.ticketing.refund.howTo.length > 0 && (
                      <ul>
                        {data.ticketing.refund.howTo.map((h) => (
                          <li key={h}>{h}</li>
                        ))}
                      </ul>
                    )}
                    {data.ticketing.refund.notes.map((n) => (
                      <p key={n} className="muted">
                        {n}
                      </p>
                    ))}
                  </section>
                )}
                {data.ticketing.serviceDesk && (
                  <section>
                    <h2>数字弱势群体服务台</h2>
                    <p>地点：{data.ticketing.serviceDesk.location}</p>
                    <p>适用：{data.ticketing.serviceDesk.eligible}</p>
                    <p>可购：{data.ticketing.serviceDesk.screenings}</p>
                    <ul>
                      {data.ticketing.serviceDesk.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {data.ticketing.ticketBoxes?.length ? (
                  <section>
                    <h2>票务亭地点与运营时间</h2>
                    <dl className="definition-list">
                      {data.ticketing.ticketBoxes.map((b) => (
                        <div key={b.place}>
                          <dt>{b.place}</dt>
                          <dd>
                            {b.period}
                            {b.open && ` · 开 ${b.open}`}
                            {b.close && ` · 关 ${b.close}`}
                            {b.payment && <span className="muted"> · {b.payment}</span>}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ) : null}
                {data.ticketing.venueRules?.items.length ? (
                  <section>
                    <h2>入场与观影规则</h2>
                    <ul>
                      {data.ticketing.venueRules.items.map((r) => (
                        <li key={r.text}>
                          {r.text}
                          {r.notes.map((n) => (
                            <span key={n} className="muted"> {n}</span>
                          ))}
                        </li>
                      ))}
                    </ul>
                    {data.ticketing.venueRules.lostAndFound.map((n) => (
                      <p key={n} className="muted">{n}</p>
                    ))}
                    <p className="muted">
                      出处：{data.ticketing.venueRules.source}（官网售票页不印这一节）
                    </p>
                  </section>
                ) : null}
                <section>
                  <h2>开闭幕式 · 红毯时间表</h2>
                  <p>开幕：{data.ceremony.openingDate}</p>
                  <p>闭幕：{data.ceremony.closingDate}</p>
                  <p className="muted">
                    两场同一时间表。⚠ 排片表把开幕式整体记为 001 场次（以该场次时间为准）；
                    此处是官网开闭幕式页印的典礼流程，两者口径不同。
                  </p>
                  {data.ceremony.slots.map((s) => (
                    <p key={`${s.time}-${s.text}`}>
                      {s.time} {SLOT_ZH[s.text] ?? s.text}
                    </p>
                  ))}
                  {data.ceremony.traffic.length > 0 && <h3>当天周边交通管制（开幕 / 闭幕两日）</h3>}
                  {data.ceremony.traffic.map((t) => (
                    <p key={t.road}>
                      {t.window} {t.road}
                    </p>
                  ))}
                  {data.ceremony.traffic.length > 0 && <p className="muted">封路时段内建议改乘公共交通；BCC 周边无指定车位。</p>}
                  <Link
                    href={data.ceremony.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    官方典礼说明
                  </Link>
                </section>
              </div>
            ) : (
              <p>购票信息尚未加载，请到 BIFF 官网查看。</p>
            )}
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              关闭
            </Button>
          </ButtonGroup>
        </>
        );
      }}
    </Dialog>
  );
}
export function GuideDialog() {
  const { cat } = useCatalog();
  // 按影院(而非放映厅)聚合 —— 地址 / 楼层 / 地图入口都是影院级的。
  const groups = useMemo(() => {
    const byGroup = new Map<string, Venue[]>();
    for (const v of cat.venues) {
      const list = byGroup.get(v.group);
      if (list) list.push(v);
      else byGroup.set(v.group, [v]);
    }
    return [...byGroup.entries()].map(([group, halls]) => ({ group, halls, place: venuePlace(group) }));
  }, [cat.venues]);
  return (
    <Dialog size="L">
      {({ close }) => (
        <>
          <Heading slot="title">日程表说明</Heading>
          <Content>
            <div className="info-sections">
              <section>
                <h2>选片与排场</h2>
                <p>
                  在影片库将想看的电影加入选片，在场次卡片中加入行程。相互重叠的场次可以保留为抢票备选，在「我的行程」调整顺位，再保存方案。
                </p>
              </section>
              <section>
                <h2>状态与时间</h2>
                <dl className="definition-list">
                  <div>
                    <dt>已选</dt>
                    <dd>绿色表示已加入行程。</dd>
                  </div>
                  <div>
                    <dt>时间紧张</dt>
                    <dd>黄色表示扣除跨馆缓冲后余量不足 15 分钟。</dd>
                  </div>
                  <div>
                    <dt>时间重叠</dt>
                    <dd>红色表示放映时间重叠，不能同时观看。</dd>
                  </div>
                  <div>
                    <dt>映后谈</dt>
                    <dd>可逐场决定是否参加和时长，日历与冲突判定同步更新。</dd>
                  </div>
                </dl>
                <p>
                  所有场次按韩国时间（KST）展示。跨午夜场次显示「次日」，日历导出使用
                  UTC。
                </p>
              </section>
              <section>
                <h2>观影等级</h2>
                <dl className="definition-list">
                  {RATING_ORDER.map((k) => (
                    <div key={k}>
                      <dt><FilmBadge kind={`rating-${k}`} label={k} /></dt>
                      <dd>{RATING_DEFS[k].zh}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h2>字幕与对白</h2>
                <dl className="definition-list">
                  {Object.values(SUBS_DEFS).map((d) => (
                    <div key={d.label}>
                      <dt><FilmBadge kind={`subs-${d.label}`} label={d.label} /></dt>
                      <dd>{d.zh}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>未标注</dt>
                    <dd>英文字幕与韩语对白。</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h2>场次标记</h2>
                <dl className="definition-list">
                  {BADGE_DEFS.map((d) => (
                    <div key={d.key}>
                      <dt><FilmBadge kind={d.key} label={d.label} /></dt>
                      <dd>{d.title.replaceAll(" · ", "，")}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h2>影院</h2>
                <p className="muted">
                  本届 {cat.venues.length} 个放映厅分属 {groups.length} 家影院，常规放映集中在海云台区
                  Centum City 主会场一带；Community BIFF（10/8–10/11）另在南浦洞 MEGABOX Busan Theater
                  1–4 有场次（该影院只在官方节目册里印排期，官网排期页不列）。地址为 BIFF 官网口径，
                  手机上点「Google 地图」可直接唤起导航。
                </p>
                <dl className="definition-list">
                  {groups.map(({ group, halls, place }) => (
                    <div key={group}>
                      <dt className="venue-codes">
                        {halls.map((h) => (
                          <span key={h.id} className="code venue-code">{h.code}</span>
                        ))}
                      </dt>
                      <dd>
                        <strong>{place?.name ?? halls[0].name}</strong>
                        {place && <span className="muted">　{place.nameZh}</span>}
                        <br />
                        <span className="muted">{place?.nameKr ?? halls[0].name_kr}</span>
                        {place && (
                          <>
                            <br />
                            <span className="muted">
                              {regionLabel(place.region)} · {place.location}
                            </span>
                            <br />
                            <span className="muted">{place.address}</span>
                            <br />
                            <span className="muted">{place.addressKr}</span>
                          </>
                        )}
                        <br />
                        厅：{halls.map((h) => venueShort(h)).join(" / ")}
                        {place && (
                          <>
                            <br />
                            <Link
                              href={mapsUrl(place)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              在 Google 地图打开
                            </Link>
                          </>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
              <p className="muted">
                排期与嘉宾安排以 BIFF 官网及现场公告为准。
              </p>
            </div>
          </Content>
          <ButtonGroup>
            <ActionButton onPress={close}>关闭</ActionButton>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
