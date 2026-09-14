import { useState } from "react";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogTrigger, Heading } from "./spectrum";
import { useCatalog, useStore } from "../app/store";
import {
  addedByVenue,
  changelogHighlights,
  markSeen,
  peekChangelog,
  seenVersion,
} from "../changelog";
import { allCodes, store, toggleScreening } from "../state";
import { filmNodeKey } from "../util";
import type { Catalog, ChangelogAdded } from "../types";

/** 场次片名(中文优先,与全站 `displayTitle` 同口径)。 */
function titleOf(cat: Catalog, s: ChangelogAdded): string {
  return s.title_zh || s.title_en || cat.byCode.get(s.code)?.title_en || s.code;
}

/** 顶栏「数据更新」入口 —— **有更新且未确认**时才渲染,否则整块返回 null。
 *
 *  为什么不做自动弹窗:用户可能正在排片,打扰式弹层会打断操作;徽章 + 常驻按钮已足够显眼。
 *  为什么不做「每场一个红点」:本轮 830 场里只有 9 条变化,逐场标记的噪声远大于信息量。 */
export function DataUpdateButton() {
  const { cat } = useCatalog();
  const [seen, setSeen] = useState(seenVersion);
  useStore(); // 选片变化时重算「与我相关」的条数
  const highlights = changelogHighlights(cat, {
    codes: new Set(allCodes()),
    filmKeys: new Set(store.picks.keys()),
    seen,
  });
  if (!highlights.hasUpdate) return null;
  return (
    <DialogTrigger>
      <ActionButton>
        数据更新
        {highlights.relevant > 0 && (
          <span className="ml-1 rounded-8 bg-biff px-1 text-12 text-on-brand">{highlights.relevant}</span>
        )}
      </ActionButton>
      <ChangelogDialog
        highlights={highlights}
        onSeen={() => {
          const version = peekChangelog()?.schedule_generated_at ?? "";
          markSeen(version);
          setSeen(seenVersion());
        }}
      />
    </DialogTrigger>
  );
}

function ChangelogDialog({
  highlights,
  onSeen,
}: {
  highlights: ReturnType<typeof changelogHighlights>;
  onSeen: () => void;
}) {
  const { cat } = useCatalog();
  const file = peekChangelog();
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  if (!file) return null;
  const groups = addedByVenue(highlights.othersAdded);

  const addToAgenda = (s: ChangelogAdded): void => {
    toggleScreening(filmNodeKey(cat, s), s.code);
    setAdded((prev) => new Set(prev).add(s.code));
  };

  return (
    <Dialog size="L">
      {({ close }) => (
        <>
          <Heading slot="title">排期数据更新</Heading>
          <Content>
            <p className="muted">
              本次同步：新增 {highlights.addedTotal} 场 · {file.changed.length} 场信息有变化
            </p>

            {highlights.mine.length > 0 && (
              <section>
                <h2>你的行程有 {highlights.mine.length} 场变化</h2>
                <dl className="definition-list">
                  {highlights.mine.map((c) => (
                    <div key={c.code}>
                      <dt>
                        {c.title_zh || c.title_en}
                        <span className="muted">　{c.date} · {c.venue_display}</span>
                      </dt>
                      <dd>
                        {c.fields.map((f) => (
                          <span key={f.key} className="mr-3">
                            {f.label} {f.from} → <strong>{f.to}</strong>
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="muted">片长 / 结束时间变化会影响行程的结束时间与冲突判定，建议看一眼。</p>
              </section>
            )}

            {highlights.myFilmsAdded.length > 0 && (
              <section>
                <h2>你选过的影片有 {highlights.myFilmsAdded.length} 场新排期</h2>
                <ul>
                  {highlights.myFilmsAdded.map((s) => (
                    <li key={s.code}>
                      {titleOf(cat, s)}
                      <span className="muted">
                        　{s.date} {s.start_time} · {s.venue_display}
                      </span>{" "}
                      {added.has(s.code) || store.slotIndex.has(s.code) ? (
                        <span className="muted">已加入行程</span>
                      ) : (
                        <ActionButton onPress={() => addToAgenda(s)}>加入行程</ActionButton>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {groups.length > 0 && (
              <section>
                {/* 放映厅数必须按**全部**新增算(`file.added`),不能复用下面的 `groups`
                    —— `groups` 是 `othersAdded`(已剔掉「你选过的影片」那批),而标题里的场次
                    数 `addedTotal` 是总数:两个集合不同,标题会自相矛盾
                    (实测 e2e 夹具:2 场分属 2 个厅,却写「2 场(1 家影院)」)。
                    另外单位是**放映厅**不是影院 —— `venue_display` 是「MEGABOX Busan Theater 1」
                    这种厅级名字,写「家影院」会把 MEGABOX 1–4 说成 4 家影院。 */}
                <h2>本次新增 {highlights.addedTotal} 场（{addedByVenue(file.added).length} 个放映厅）</h2>
                {highlights.myFilmsAdded.length > 0 && (
                  <p className="muted">
                    其中 {highlights.myFilmsAdded.length} 场属于你选过的影片，已在上面单列。
                  </p>
                )}
                <dl className="definition-list">
                  {groups.map(({ venue, list }) => (
                    <div key={venue}>
                      <dt>{venue}</dt>
                      <dd>
                        {list.length} 场
                        <details className="mt-1">
                          <summary>查看片名</summary>
                          <ul>
                            {list.map((s) => (
                              <li key={s.code}>
                                {titleOf(cat, s)}
                                <span className="muted">　{s.date} {s.start_time}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="muted">
                  新增场次来自官方付印节目册（官网排期页不列这些影院），片单见「排片表」。
                </p>
              </section>
            )}
          </Content>
          <ButtonGroup>
            <Button
              variant="secondary"
              onPress={() => {
                onSeen();
                close();
              }}
            >
              知道了
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
