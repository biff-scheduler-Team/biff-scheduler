// 「已保存方案」的「查看场次」弹层(2026-09-14,PLAN-20260914213000)。
//
// ★ 为什么是弹层 + 复用海报模型,而不是原来那个 <details> 内联纯文本:
//   ① 内联只能逐行印「HH:MM · CODE」,看不出这是哪部片、在哪个影院 —— 而保存方案正是
//      「过几天照着这份清单去看片」,信息不够用;
//   ② 「一场该展示什么」这件事在分享图片(`poster.ts::buildPosterModel`)里已经定好了:
//      有效结束时间(含 / 弃映后谈按单场解析)/ 英文名 · 中文名 / 影院短名 / GV 标记 /
//      备注 / 海报缩略图。这里**直接复用同一份模型**,不再另起一套口径。
//   ⚠ 本组件只是 `buildPosterModel` 的 DOM 出口;排序与文案全在 `poster.ts`(可单测)。

import { buildPosterModel } from "../poster";
import { useCatalog } from "../app/store";
import { slotOf, store, type SavedPlan } from "../state";
import { talkOnOf } from "../gv";
import type { PickRow } from "../ics";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
} from "./spectrum";

export function PlanShowsDialog({ plan }: { plan: SavedPlan }) {
  const { cat } = useCatalog();
  // 备注与分享图片 / 分享文案同源:场次级取 code,备注在影片级(store.picks)
  const rows: PickRow[] = plan.codes
    .filter((code) => cat.byCode.has(code))
    .map((code) => ({
      code,
      note: store.picks.get(slotOf(code)?.key ?? "")?.note ?? "",
    }));
  const model = buildPosterModel(cat, rows, store.mappings, talkOnOf);
  // 排期换版后残留的 code:海报模型里根本不存在,单独列出来,别让它静默消失
  const gone = plan.codes.filter((code) => !cat.byCode.has(code));
  return (
    <DialogTrigger>
      <ActionButton aria-label={`查看「${plan.name}」的场次`}>查看场次</ActionButton>
      <Dialog size="M">
        {({ close }) => (
          <>
            <Heading slot="title">{plan.name}</Heading>
            <Content>
              {model ? (
                <div className="plan-shows">
                  <p className="muted">
                    {model.range} · 共 {model.count} 场 / {model.films} 部
                  </p>
                  {gone.length > 0 && (
                    <p className="muted">
                      {gone.length} 场已不在当前排期：{gone.join("、")}
                    </p>
                  )}
                  {model.days.map((day) => (
                    <section className="plan-shows-day" key={day.label}>
                      <h3>
                        {day.label} {day.weekday}
                        <span>{day.count} 场</span>
                      </h3>
                      <ul>
                        {day.rows.map((row) => (
                          <li key={row.code}>
                            {row.poster ? (
                              <img
                                className="plan-shows-poster"
                                src={row.poster}
                                alt=""
                                loading="lazy"
                              />
                            ) : (
                              // 缺海报是常态(与分享图片同一处理):占位块印 CODE,不留空洞
                              <span
                                className="plan-shows-poster plan-shows-poster-empty"
                                aria-hidden="true"
                              >
                                {row.code}
                              </span>
                            )}
                            <div className="plan-shows-body">
                              <p className="plan-shows-time">
                                {row.time}
                                {row.gv && (
                                  <span className="plan-shows-gv">{row.gv}</span>
                                )}
                              </p>
                              <p className="plan-shows-title">{row.title}</p>
                              <p className="plan-shows-meta">
                                {row.venue} · {row.code}
                              </p>
                              {row.note && (
                                <p className="plan-shows-note">备注 {row.note}</p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  这个方案的场次已不在当前排期
                  {gone.length ? `：${gone.join("、")}` : "。"}
                </p>
              )}
            </Content>
            <ButtonGroup>
              <Button variant="secondary" onPress={close}>
                关闭
              </Button>
            </ButtonGroup>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
