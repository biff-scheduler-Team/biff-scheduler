/**
 * 「这一场几张票、分别坐哪」的编辑弹层(2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 核心交互:**加一张座位 = 多一张票**(用户 2026-09-24 拍板「直接通过操作去添加座位表…
 *   用添加的座位数作为票数」)。所以这里**没有**「几张票」的输入框 —— 票数是座位行数的派生值,
 *   两个来源必然会打架。加/删行是唯一入口。
 * ★ **两个档位(修订 4)**:「划位」(逐行填座位号)与「不划位」(自由入座,只记张数)。
 *   不划位的场次**没有座位号可填**,在这里逼用户面对一排空的「座位号,如 F12」是说不通的
 *   (用户 2026-09-24:「有不划位的 需要考虑这种情况」)。两个档位落的是**同一份数据**
 *   (N 个座位行,不划位那档全是空串),故档位本身不落库 —— 见 `ticket-info.ts::allSeatsBlank`。
 * ★ 「不划位」的**初始档位**由 `defaultUnreserved` 给(露天场 `bt`、且不是开闭幕)——
 *   那是常识默认,不是数据(片单里查不到「划位 / 不划位」字段)。
 * ★ 落哪份数据:座位行 + 持票信息 → `biff.ticketinfo.v3`(`state.ts::setTicketInfo`)。
 *   ⚠ 它**随片单上云**(跨设备能看见),所以这里不许放任何凭据 ——
 *     「账号」那一栏存的是账号**名**标签,不是密码;账号 / 密码方案已在修订 3 整体撤销,
 *     理由见 `docs/CONVENTIONS.md`。
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
  Checkbox,
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
import { TICKET_COUNT_MAX, allSeatsBlank, defaultUnreserved } from "../ticket-info";
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
  // 持票信息(修订 5)。**每场一条**,与座位行数无关 —— 一笔预约 1~2 张票共用同一个预约号 / 姓名 / 账号
  // (用户 2026-09-24 给的 17 笔明细就是这个粒度)。
  // ⚠ 「账号」记的是账号**名**(如 `foxmail`),不是密码 —— 本结构落在 `biff.` 前缀下会随片单上云。
  const [name, setName] = useState(existing?.name ?? "");
  const [bookingNo, setBookingNo] = useState(existing?.bookingNo ?? "");
  const [account, setAccount] = useState(existing?.account ?? "");
  /** 「不划位」档(2026-09-24 修订 4:用户「有不划位的 需要考虑这种情况」)。
   *  ⚠ 它**不落库** —— 落库的仍然只有座位行。重开时按两段判回来:
   *    存过明细 → `allSeatsBlank`(全空 = 不划位);从没存过 → `defaultUnreserved`(场馆默认)。
   *  ⚠ 想加 `unreserved` 字段就得多起一只 `biff.ticketinfo.v3` + 一条迁移链,用户选了不加。 */
  const [unreserved, setUnreserved] = useState(() =>
    existing ? allSeatsBlank(existing) : defaultUnreserved(s.venue_id, s.tags ?? []),
  );

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

  /** 「－ 减一张」:砍掉最后一行。不划位档没有逐行删除按钮(那里本来就没有「第 N 行」可言)。 */
  const removeLast = () => setSeats((previous) => previous.slice(0, -1));

  /** 一行都没有 = 这一场没有明细 → 清掉记录(不留空壳,也免得徽章写着「1 张」)。 */
  const save = () => {
    // 「不划位」落库时把座位号**清成空串**:档位说的是「这场没有座位号」,留着旧值会让这条记录
    // 下次打开被判回「划位」档(`allSeatsBlank` 为假)—— 明明标了不划位、重开却变成划位,自相矛盾。
    // ⚠ 清空**只在这里**发生,不是切档位时:在弹层里来回切一下不该丢掉刚抄下来的座位号
    //   (切回去还在,保存才算数)。张数一行不少 —— 它由行数派生,与座位号的内容无关。
    const finalSeats = unreserved ? seats.map(() => "") : seats;
    // ⚠ 空串在这里就交出去,由 `normalizeTicketInfo` 统一折成「未填」——
    //   两个来源各判一次「空不空」迟早会漂(与读取端同一份判据)。
    if (finalSeats.length) setTicketInfo(s.code, { seats: finalSeats, name, bookingNo, account });
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
            {/* 「不划位」档位(2026-09-24 修订 4)。⚠ 它**不落库** —— 落库的只有座位行,
                这一档是重开弹层时按「座位行全空 / 场馆默认」推断出来的显示态
                (`ticket-info.ts::allSeatsBlank` / `defaultUnreserved`)。
                这也正是它能随手切、不必当成一份要保存的数据的原因。 */}
            {/* ⚠ 切档位**只切档位、不动座位号**(所以直接给 `setUnreserved`):值先留着,切回来还在;
                「不划位 = 没有座位号」这件事由 `save` 落库时保证 —— 见那儿的 `finalSeats`。 */}
            <Checkbox isSelected={unreserved} onChange={setUnreserved}>
              这场不划位（自由入座，没有座位号）
            </Checkbox>
            {unreserved ? (
              <div className="ticket-seats" role="group" aria-label="票数">
                <span className="ticket-seats-title">
                  <strong>加一张就是多一张票</strong> —— 只记张数，不用填座位号
                </span>
                <div className="ticket-seat-row">
                  {/* 「减」只砍最后一行:不划位档没有「第 N 行」可言,逐行删除在这里是多余的按钮 */}
                  <ActionButton isDisabled={seats.length === 0} onPress={removeLast}>
                    － 减一张
                  </ActionButton>
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
                    还没记张数。点「＋ 添加一张」，行程概览的「共 N 张票」按它合计。
                  </p>
                )}
              </div>
            ) : (
              <div className="ticket-seats" role="group" aria-label="座位表">
                <span className="ticket-seats-title">
                  座位表 —— <strong>加一张就是多一张票</strong>，座位号没抄下来可以先留空（只有你自己看得到）
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
                  // ⚠ 整句写在一行里:JSX 会把折行处的换行 + 缩进压成一个**空格**,
                  //   中文里「合计； 这场」多出来的那个空格是肉眼可见的瑕疵。
                  <p className="ticket-hint">
                    还没加座位行。加一行就是一张票，行程概览的「共 N 张票」按行数合计；这场要是不划位，就勾上面的复选框。
                  </p>
                )}
              </div>
            )}
            {/* 持票信息(修订 5,为票务导入而加)。⚠ 三项都是**每场一条**:一笔预约的 1~2 张票
                共用同一个姓名 / 预约号 / 账号 —— 这也是用户给的明细表里的粒度。
                ⚠ 「账号」是账号**名**标签,不是密码:本结构落在 `biff.` 前缀下会随片单上云,
                  而修订 3 撤销的正是「存密码」那一套。标签里把这句写明确。 */}
            <div className="ticket-holder" role="group" aria-label="持票信息">
              <TextField
                label="姓名"
                placeholder="如 RAOJIARUI"
                value={name}
                onChange={setName}
              />
              <TextField
                label="预约号"
                placeholder="BIFF 订单号，换票 / 查订单时要报"
                value={bookingNo}
                onChange={setBookingNo}
              />
              <TextField
                label="账号（只记账号名，别填密码）"
                placeholder="如 foxmail"
                value={account}
                onChange={setAccount}
              />
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
