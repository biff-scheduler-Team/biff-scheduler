/**
 * 「这一场几张票、分别坐哪」的编辑弹层(2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 核心交互:**加一张座位 = 多一张票**(用户 2026-09-24 拍板「直接通过操作去添加座位表…
 *   用添加的座位数作为票数」)。所以这里**没有**「几张票」的输入框 —— 票数是座位行数的派生值,
 *   两个来源必然会打架。加/删行是唯一入口。
 * ★ 落哪份数据:座位行 → `biff.ticketinfo.v2`(`state.ts::setTicketInfo`)。
 *   ⚠ 它**随片单上云**(跨设备能看见),所以这里不许放任何凭据 ——
 *     账号 / 密码方案已在修订 3 整体撤销,理由见 `docs/CONVENTIONS.md`。
 * ★ 为什么是模态 `Dialog` 而不是 `ScreeningInfoPopover` 那种非模态 `Popover`:里面全是输入框,
 *   需要焦点陷阱与「关掉就交回焦点」;仓库既有的同类路径是 `AgendaRemoveDialog`
 *   (`ScheduleGantt.tsx`)+ `DialogContainer` 条件挂载 —— 那条路径还顺带避开了
 *   `SettingsDialog::ClearDialog` 记下的坑(常驻 `Dialog` 会被当成「当前弹层」一起显示)。
 * ★ 「打开 BIFF 票务」的**能力边界**(别把文案写大):`ticket.biff.kr` 会 302 到第三方平台
 *   `biff.maketicket.co.kr`,**是另一个域** —— 本站既没法写它的登录框,也没法替它建会话,
 *   所以只能把票务站打开、由用户自己的浏览器登录态决定进不进得去 My page(订单页)。
 */

import { useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  TextField,
  ToastQueue,
} from "./spectrum";
import { useCatalog } from "../app/store";
import { extras } from "../extras";
import { effEndMin, talkOnOf } from "../gv";
import { setTicketInfo, clearTicketInfo, store, ticketInfoOf } from "../state";
import { TICKET_COUNT_MAX } from "../ticket-info";
import { dateInfo, filmInfoOf, fmtEndClock, safeExternalUrl } from "../util";
import { venueShort } from "../legend";
import type { Screening } from "../types";
import "./ticket-info.css";

export function TicketEditDialog({
  screening: s,
  onDismiss,
}: {
  screening: Screening;
  onDismiss: () => void;
}) {
  const { cat } = useCatalog();
  const existing = ticketInfoOf(s.code);
  // 座位表就是**唯一的编辑面**:打开时按已存的座位行铺出来(空行也是「一张票」)。
  const [seats, setSeats] = useState<string[]>(() => [...(existing?.seats ?? [])]);

  const venue = cat.venueById.get(s.venue_id);
  const title = filmInfoOf(cat, s, store.mappings.get(s.code)).title;
  const booking = safeExternalUrl(extras()?.ticketing.bookingUrl);
  const full = seats.length >= TICKET_COUNT_MAX;

  /** 加一行空座位 = 多一张票。
   *  ⚠ **刻意不自动聚焦新行**:S2 的 `TextField` 要拿到底层 `<input>` 得走它的 ref API
   *    (`getInputElement()`),为这点便利去挂一堆 ref 不值得;加号按钮本身不会被顶走太多,
   *    连续点几下再回来填也顺手。 */
  const addSeat = () => {
    if (full) return;
    setSeats((previous) => [...previous, ""]);
  };

  const patchSeat = (index: number, value: string) =>
    setSeats((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });

  const removeSeat = (index: number) =>
    setSeats((previous) => previous.filter((_, i) => i !== index));

  /** 一行都没有 = 这一场没有明细 → 清掉记录(不留空壳,也免得徽章写着「1 张」)。 */
  const save = () => {
    if (seats.length) setTicketInfo(s.code, { seats });
    else clearTicketInfo(s.code);
    ToastQueue.positive("票务信息已保存", { timeout: 5000 });
    onDismiss();
  };

  return (
    <DialogContainer onDismiss={onDismiss}>
      {/* `size="M"`:`S` 档内容区只有 336px,「第 N 张 + 输入框 + 删除」三件并排会挤到折行 */}
      <Dialog size="M">
        <Heading slot="title">编辑场次 {s.code} 的票务</Heading>
        <Content>
          <div className="ticket-info-dialog">
            <p className="ticket-hint">
              《{title}》 {dateInfo(s.date).label} {s.start_time.slice(0, 5)}–
              {fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
              {venue ? `，${venueShort(venue)}` : ""}
            </p>
            <div className="ticket-seats" role="group" aria-label="座位表">
              <span className="ticket-seats-title">
                座位表 —— <strong>加一张就是多一张票</strong>，空着也行（座位号只有你自己看得到）
              </span>
              {seats.map((seat, index) => (
                <div className="ticket-seat-row" key={index}>
                  {/* ⚠ label 走 `labelPosition="side"` 与输入框同行,且**只有这一份**标签 ——
                      它同时是唯一区分的可访问名(多张票时必须唯一,否则读屏 / e2e 分不清是第几张)。 */}
                  <TextField
                    labelPosition="side"
                    label={`第 ${index + 1} 张`}
                    placeholder="座位号，如 F12"
                    value={seat}
                    onChange={(value) => patchSeat(index, value)}
                  />
                  <ActionButton
                    aria-label={`删除第 ${index + 1} 张`}
                    onPress={() => removeSeat(index)}
                  >
                    删除
                  </ActionButton>
                </div>
              ))}
              <div className="ticket-seats-foot">
                <ActionButton isDisabled={full} onPress={addSeat}>
                  ＋ 添加一张
                </ActionButton>
                <span className="ticket-seats-count" aria-live="polite">
                  {seats.length} 张票
                  {full ? `（已达上限 ${TICKET_COUNT_MAX} 张）` : ""}
                </span>
              </div>
              {seats.length === 0 && (
                <p className="ticket-hint">
                  还没加座位行。加一行就是一张票，行程概览的「共 N 张票」按行数合计。
                </p>
              )}
            </div>
            {booking && (
              <div className="ticket-shortcuts" role="group" aria-label="票务快捷操作">
                {/* 落地页是第三方售票平台(`biff.maketicket.co.kr`)。
                    打开它不需要我们存任何凭据 —— 进不进得去订单页只取决于你自己的登录态。 */}
                <ActionButton
                  size="S"
                  onPress={() => window.open(booking, "_blank", "noopener,noreferrer")}
                >
                  ↗ 打开 BIFF 票务
                </ActionButton>
              </div>
            )}
          </div>
        </Content>
        {/* `align="end"`:内容整列左对齐,底部按钮若居中会让重心歪到中间 */}
        <ButtonGroup align="end">
          <Button variant="secondary" onPress={onDismiss}>
            取消
          </Button>
          <Button onPress={save}>保存票务信息</Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
