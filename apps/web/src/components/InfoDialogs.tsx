import { FilmBadge } from "./ScreeningCard";
import { useMemo } from "react";
import {
  ActionButton,
  ButtonGroup,
  Content,
  Dialog,
  Heading,
  Link,
} from "./spectrum";
import { useCatalog } from "../app/store";
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
import { SCHEDULED_STATE, SCHEDULE_LABEL, WANT_LABEL } from "../actions-copy";
import type { Venue } from "../types";


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
                  在影片库点「{WANT_LABEL}」把片子收进选片，再在场次卡上点「{SCHEDULE_LABEL}」排进当天行程。相互重叠的场次可以保留为抢票备选，在「我的行程」调整顺位。
                </p>
              </section>
              <section>
                <h2>状态与时间</h2>
                <dl className="definition-list">
                  <div>
                    <dt>已选</dt>
                    <dd>绿色表示{SCHEDULED_STATE}。</dd>
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
