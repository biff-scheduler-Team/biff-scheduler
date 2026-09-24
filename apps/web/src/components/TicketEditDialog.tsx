/**
 * 「这一场几张票 / 坐哪儿 / 票在哪个账号」的编辑弹层(2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 落哪份数据:张数 / 座位 / 账号覆盖 → `biff.ticketinfo.v1`(`state.ts::setTicketInfo`);
 *   **账号与密码本身不在这里** —— 它们是本地专属的另一只键,见 `ticket-accounts.ts` 文件头。
 * ★ 为什么是模态 `Dialog` 而不是 `ScreeningInfoPopover` 那种非模态 `Popover`:里面全是输入框,
 *   需要焦点陷阱与「关掉就交回焦点」;仓库既有的同类路径是 `AgendaRemoveDialog`
 *   (`ScheduleGantt.tsx`)+ `DialogContainer` 条件挂载 —— 那条路径还顺带避开了
 *   `SettingsDialog::ClearDialog` 记下的坑(常驻 `Dialog` 会被当成「当前弹层」一起显示)。
 * ★ 「快速跳转」的**能力边界**(别把文案写大):`ticket.biff.kr` 是跨域站点,本站没有任何合法
 *   手段往它的登录框写值 —— 能做的只有「打开站点 + 一键复制凭据」,所以按钮说的是「复制」,
 *   不是「登录」。
 */

import { useEffect, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  Link,
  NumberField,
  Picker,
  PickerItem,
  TextField,
  ToastQueue,
} from "./spectrum";
import { useCatalog } from "../app/store";
import { copyText } from "../clipboard";
import { extras } from "../extras";
import { effEndMin, talkOnOf } from "../gv";
import { setTicketInfo, clearTicketInfo, store, ticketInfoOf } from "../state";
import { TICKET_COUNT_MAX, ticketCountOf } from "../ticket-info";
import {
  accountById,
  accountLabelOf,
  peekTicketAccounts,
  resolveAccountOf,
  subscribeTicketAccounts,
} from "../ticket-accounts";
import { dateInfo, filmInfoOf, fmtEndClock, safeExternalUrl } from "../util";
import { venueShort } from "../legend";
import type { Screening } from "../types";
import "./ticket-info.css";

/** 账号下拉里「跟随设置里的默认账号」那一项 —— 它必须有 id,但不能撞上真实账号 id
 *  (真实 id 是 UUID / `acc-…`,不含双下划线包裹的形态)。 */
const DEFAULT_ACCOUNT = "__default__";

export function TicketEditDialog({
  screening: s,
  onDismiss,
}: {
  screening: Screening;
  onDismiss: () => void;
}) {
  const { cat } = useCatalog();
  // 账号表在**另一个 store**(本地专属键,不进 `state.ts`),显式订阅一次
  const [, force] = useState(0);
  useEffect(() => subscribeTicketAccounts(() => force((n) => n + 1)), []);
  const accountsFile = peekTicketAccounts();
  const existing = ticketInfoOf(s.code);
  const [count, setCount] = useState(() => ticketCountOf(existing) ?? 1);
  const [seats, setSeats] = useState<string[]>(() => {
    const initial = existing?.seats ?? [];
    return Array.from({ length: ticketCountOf(existing) ?? 1 }, (_, i) => initial[i] ?? "");
  });
  const [accountKey, setAccountKey] = useState<string>(existing?.accountId ?? DEFAULT_ACCOUNT);

  const venue = cat.venueById.get(s.venue_id);
  const title = filmInfoOf(cat, s, store.mappings.get(s.code)).title;
  // 选中的账号 id 在本机找不到(跨设备同步过来的旧 id / 账号已被删)—— 说清楚,别让人以为设置没生效。
  // ⚠ 判据取的是**当前下拉选中值**而不是存下来的 `existing.accountId`:用户在下拉里另选一个之后,
  //   那句「保存后改为跟随默认账号」就已经不成立了 —— 挂在旧值上会让提示与实际发生的事相互矛盾。
  const orphaned = accountKey !== DEFAULT_ACCOUNT && !accountById(accountsFile, accountKey);
  const override = accountKey === DEFAULT_ACCOUNT ? undefined : accountKey;
  const resolved = resolveAccountOf(accountsFile, { accountId: override });
  const booking = safeExternalUrl(extras()?.ticketing.bookingUrl);

  /** 改张数:座位数组跟着伸缩(多出来的补空,少掉的截断)。 */
  const changeCount = (next: number) => {
    const value = Math.max(1, Math.min(TICKET_COUNT_MAX, Math.round(next) || 1));
    setCount(value);
    setSeats((previous) => Array.from({ length: value }, (_, i) => previous[i] ?? ""));
  };

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    if (ok) ToastQueue.positive(`${what}已复制`, { timeout: 5000 });
    else ToastQueue.neutral(`复制失败，请手动选中「${what}」再复制`, { timeout: 5000 });
  };

  /** 三样都等于默认值(1 张 / 没填座位 / 跟随默认账号)= 没有明细要记 → 清掉这一条。
   *  不然「打开看一眼就保存」会给每一场都留下一个 `{count:1}`,把格子徽章糊满。 */
  const save = () => {
    const meaningful = count !== 1 || seats.some((seat) => seat.trim()) || Boolean(override);
    if (meaningful) setTicketInfo(s.code, { count, seats, accountId: override });
    else clearTicketInfo(s.code);
    ToastQueue.positive("票务信息已保存", { timeout: 5000 });
    onDismiss();
  };

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="S">
        <Heading slot="title">编辑场次 {s.code} 的票务</Heading>
        <Content>
          <div className="ticket-info-dialog">
            <p className="ticket-hint">
              《{title}》{dateInfo(s.date).label} {s.start_time.slice(0, 5)}–
              {fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
              {venue ? `，${venueShort(venue)}` : ""}
            </p>
            <NumberField
              label="有几张票"
              description="留空 / 1 张都等于「按 1 张算」；行程概览的「共 N 张票」用它合计。"
              minValue={1}
              maxValue={TICKET_COUNT_MAX}
              value={count}
              onChange={changeCount}
            />
            <div className="ticket-seats" role="group" aria-label="座位号">
              <span className="ticket-seats-title">座位号（可留空，只有你自己看得到）</span>
              {Array.from({ length: count }, (_, i) => (
                <div className="ticket-seat-row" key={i}>
                  <span>第 {i + 1} 张</span>
                  <TextField
                    label={`第 ${i + 1} 张座位号`}
                    placeholder="如 F12"
                    value={seats[i] ?? ""}
                    onChange={(value) =>
                      setSeats((previous) => {
                        const next = [...previous];
                        next[i] = value;
                        return next;
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <Picker
              label="这一场的票在哪个账号"
              value={accountKey}
              onChange={(value) => setAccountKey(String(value))}
            >
              <PickerItem id={DEFAULT_ACCOUNT}>
                {accountsFile.defaultId
                  ? `跟随默认账号（${accountLabelOf(resolveAccountOf(accountsFile, undefined)!)}）`
                  : "跟随默认账号（尚未设置默认账号）"}
              </PickerItem>
              {accountsFile.accounts.map((account) => (
                <PickerItem id={account.id} key={account.id}>
                  {accountLabelOf(account)}
                </PickerItem>
              ))}
            </Picker>
            {orphaned && (
              <p className="ticket-hint ticket-hint-warn">
                这一场原先指定的账号已不在本机（换设备后账号表不会跟着同步），保存后改为跟随默认账号。
              </p>
            )}
            {!accountsFile.accounts.length && (
              <p className="ticket-hint">
                还没有配置票务账号。到「设置 → BIFF 票务账号」里添加，之后这里就能选。
              </p>
            )}
            <div className="ticket-shortcuts" role="group" aria-label="票务快捷操作">
              {booking && (
                <Link href={booking} target="_blank" rel="noopener noreferrer">
                  打开 BIFF 票务
                </Link>
              )}
              <ActionButton
                isDisabled={!resolved}
                onPress={() => resolved && void copy(resolved.username, "用户名")}
              >
                复制用户名
              </ActionButton>
              <ActionButton
                isDisabled={!resolved?.password}
                onPress={() => resolved && void copy(resolved.password, "密码")}
              >
                复制密码
              </ActionButton>
            </div>
            {resolved ? (
              <p className="ticket-hint">
                当前账号:{accountLabelOf(resolved)}
                {resolved.password ? "" : "（没有保存密码）"}。
                密码只存在这台设备，本站不代填 —— 打开票务站后粘贴即可。
              </p>
            ) : (
              <p className="ticket-hint">未指定账号:仍可记录张数与座位，只是没有可复制的登录凭据。</p>
            )}
          </div>
        </Content>
        <ButtonGroup>
          <Button variant="secondary" onPress={onDismiss}>
            取消
          </Button>
          <Button onPress={save}>保存票务信息</Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
