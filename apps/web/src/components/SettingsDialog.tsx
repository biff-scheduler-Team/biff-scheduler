import { useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Checkbox,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
  NumberField,
  Picker,
  PickerItem,
  TextField,
  ToastQueue,
} from "./spectrum";
import {
  clearAllPicks,
  clearScreeningSlots,
  setSettings,
  store,
} from "../state";
import {
  accountLabelOf,
  newAccountId,
  peekTicketAccounts,
  setTicketAccounts,
} from "../ticket-accounts";
import type { Settings, ThemePref, TicketAccount, TicketAccountsFile } from "../types";
import "./ticket-info.css";

/** 「默认账号」下拉里代表「不指定」的那一项 —— 与 `TicketEditDialog` 里那个哨兵**故意不同**:
 *  那个是「这一场跟随默认」,这个是「根本没有默认」。两处语义不同,别共用一个常量。 */
const NO_DEFAULT = "__none__";

/** 请求打开设置弹层(2026-09-24,`PLAN-20260924141442` 修订 2)。
 *
 *  ★ 为什么走 `window` 事件而不是 Context:设置弹层的**宿主在 `App`**(它按 `settingsSession`
 *    重挂载整只弹层),而需要打开它的却是深处的另一个弹层(`TicketEditDialog` 里那句
 *    「去设置添加」)。为这一件事从 App 往下一路透传回调,链路上每一层都要多一个无关的 prop;
 *    事件则与仓库既有的 `iffday:workspace-change` 同手法,零 prop 污染。
 *  ⚠ 事件名只有这一处定义,`App.tsx` 从本模块 import —— 别在两处各写一份字符串字面量。 */
export const OPEN_SETTINGS_EVENT = "biff:open-settings";

export function openSettingsDialog(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

/** 账号表的**深拷贝** —— `peekTicketAccounts()` 交回的是模块级活对象,
 *  弹层里就地改它等于「取消也生效」。 */
function cloneAccounts(file: TicketAccountsFile): TicketAccountsFile {
  return { accounts: file.accounts.map((account) => ({ ...account })), defaultId: file.defaultId };
}

/** 「BIFF 票务账号」区块(2026-09-24,`PLAN-20260924141442`)。
 *
 *  ⚠ 它**不是** `Settings` 的一部分,也不落 `biff.settings.v1` —— 账号 / 密码存在本地专属键里
 *    (`iffday.workspace.ticketaccounts.v1`,理由见 `ticket-accounts.ts` 文件头)。
 *    但走**同一个「保存设置」按钮**:与弹层里其它字段共享「草稿 → 保存」这一套,取消即丢弃,
 *    否则这一个弹层里会同时存在「改了就立刻生效」和「要按保存」两套规则。
 *  ⚠ 「恢复默认设置」**刻意不动账号**:那是用户录入的数据,不是偏好 —— 一次手滑不该把密码抹掉。 */
function TicketAccountsSection({
  file,
  onChange,
}: {
  file: TicketAccountsFile;
  onChange: (next: TicketAccountsFile) => void;
}) {
  const patch = (id: string, fields: Partial<TicketAccount>) =>
    onChange({
      ...file,
      accounts: file.accounts.map((account) =>
        account.id === id ? { ...account, ...fields } : account,
      ),
    });
  return (
    <section className="ticket-accounts" aria-label="BIFF 票务账号">
      <h2>BIFF 票务账号</h2>
      <p className="muted">
        在「我的行程 → 日程表」上给每一场标注「这张票在哪个账号」，并可一键复制凭据去官网登录。
        ⚠ 密码只保存在这台设备上（不进账号同步、也不会被导出到备份文件）；公用设备建议把密码留空。
      </p>
      {file.accounts.length > 0 && (
        <ul className="ticket-account-list">
          {file.accounts.map((account) => (
            <li className="ticket-account-item" key={account.id}>
              <div className="ticket-account-head">
                <strong>{accountLabelOf(account)}</strong>
                <ActionButton
                  aria-label={`删除账号 ${accountLabelOf(account)}`}
                  onPress={() =>
                    onChange({
                      accounts: file.accounts.filter((item) => item.id !== account.id),
                      // 删掉的正好是默认账号 → 默认跟着清掉,别留一个指向空气的 id
                      defaultId: file.defaultId === account.id ? null : file.defaultId,
                    })
                  }
                >
                  删除
                </ActionButton>
              </div>
              <div className="ticket-account-fields">
                <TextField
                  label="名称"
                  placeholder="如 主号"
                  value={account.label}
                  onChange={(label) => patch(account.id, { label })}
                />
                <TextField
                  label="用户名（必填）"
                  placeholder="如 me@example.com"
                  value={account.username}
                  onChange={(username) => patch(account.id, { username })}
                />
                <TextField
                  label="密码（留空 = 不保存）"
                  type="password"
                  value={account.password}
                  onChange={(password) => patch(account.id, { password })}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <ActionButton
        onPress={() =>
          onChange({
            ...file,
            accounts: [
              ...file.accounts,
              { id: newAccountId(), label: "", username: "", password: "" },
            ],
          })
        }
      >
        添加账号
      </ActionButton>
      {file.accounts.length > 0 && (
        <Picker
          label="默认账号（票里没单独指定时用它）"
          value={file.defaultId ?? NO_DEFAULT}
          onChange={(value) =>
            onChange({ ...file, defaultId: String(value) === NO_DEFAULT ? null : String(value) })
          }
        >
          <PickerItem id={NO_DEFAULT}>不指定</PickerItem>
          {file.accounts.map((account) => (
            <PickerItem id={account.id} key={account.id}>
              {accountLabelOf(account)}
            </PickerItem>
          ))}
        </Picker>
      )}
    </section>
  );
}

function ClearDialog({ all }: { all: boolean }) {
  // ⚠ **必须**只在打开时挂载 `Dialog`(与 `TransferAddDialog` 同一手法):
  //   S2 的 `DialogTrigger` 无条件渲染 children,而设置弹层自 2026-09-22 起挂在 `DialogContainer`
  //   之下(`PLAN-20260922105228`)—— 常驻的那个 `<Dialog>` 会被当成"当前弹层"一起显示出来,
  //   实测一次打开设置会同时冒出三个对话框(设置 + 这两个清空确认)。
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="negative">
        {all ? "清空全部选片" : "清空已排场次"}
      </Button>
      {open && (
        <Dialog size="S">
          {({ close }) => (
            <>
              <Heading slot="title">
                {all ? "清空全部选片？" : "清空已排场次？"}
              </Heading>
              <Content>
                <p>
                  {all
                    ? "将删除当前选片、场次与备注。设置会保留。"
                    : "将移除全部已排场次。有备注的影片会保留，其他空记录会删除；只有一场的影片会连同选片一起移除。"}
                </p>
              </Content>
              <ButtonGroup>
                <Button variant="secondary" onPress={close}>
                  取消
                </Button>
                <Button
                  variant="negative"
                  onPress={() => {
                    if (all) clearAllPicks();
                    else clearScreeningSlots();
                    ToastQueue.positive("已清空", { timeout: 5000 });
                    close();
                  }}
                >
                  确认清空
                </Button>
              </ButtonGroup>
            </>
          )}
        </Dialog>
      )}
    </DialogTrigger>
  );
}
export function SettingsDialog() {
  const [draft, setDraft] = useState(() => ({
    alarmMin: store.settings.alarmMin,
    transitMin: store.settings.transitMin,
    gvTalkOn: store.settings.gvTalkOn,
    gvTalkMin: store.settings.gvTalkMin,
    showPni: store.settings.showPni,
    theme: store.settings.theme ?? "system",
    // 票务账号(**不是** `Settings` 的一部分,见 `TicketAccountsSection`)。
    // ⚠ 必须深拷贝:直接存 `peekTicketAccounts()` 那个活对象的话,「取消」就形同虚设。
    accounts: cloneAccounts(peekTicketAccounts()),
  }));
  const [themeChanged, setThemeChanged] = useState(false);
  return (
    <Dialog>
      {({ close }) => (
        <>
          <Heading slot="title">设置</Heading>
          <Content>
            <div className="form-stack">
              <h2>行程与日历</h2>
              <NumberField
                label="日历提醒提前量（分钟）"
                minValue={0}
                maxValue={180}
                value={draft.alarmMin}
                onChange={(n) => setDraft((v) => ({ ...v, alarmMin: n }))}
              />
              <NumberField
                label="跨场馆转场缓冲（分钟）"
                description="用于判断相邻场次是否来得及赶场。"
                minValue={0}
                maxValue={120}
                value={draft.transitMin}
                onChange={(n) => setDraft((v) => ({ ...v, transitMin: n }))}
              />
              <h2>场次范围</h2>
              <Checkbox
                isSelected={draft.showPni}
                onChange={(on) => setDraft((v) => ({ ...v, showPni: on }))}
              >
                显示 P&amp;I 场次
              </Checkbox>
              <p className="muted">
                P&amp;I(Press &amp; Industry)是记者 / 业界场:官方册子排期页的
                BD(Indieplus)/ CGV 7 两列。官方不为这两列印场次编号、官网排期页也不列,
                且不对外售票。勾选后它们会与普通场次一起出现在排片表 / 片单 / 行程里
                (编号形如 PI-09-01,是本工具的内部键,不是官方编号)。
              </p>
              <h2>GV 映后谈</h2>
              <Checkbox
                isSelected={draft.gvTalkOn}
                onChange={(on) => setDraft((v) => ({ ...v, gvTalkOn: on }))}
              >
                默认参加映后谈
              </Checkbox>
              <NumberField
                label="默认映后时长（分钟）"
                minValue={0}
                maxValue={240}
                value={draft.gvTalkMin}
                onChange={(n) => setDraft((v) => ({ ...v, gvTalkMin: n }))}
              />
              <p className="muted">在场次卡片中可以单独调整，单场设置优先。</p>
              <Picker
                label="外观"
                value={draft.theme ?? "system"}
                onChange={(t) => {
                  setThemeChanged(true);
                  setDraft((v) => ({ ...v, theme: t as ThemePref }));
                }}
              >
                <PickerItem id="system">跟随系统</PickerItem>
                <PickerItem id="light">亮色</PickerItem>
                <PickerItem id="dark">暗色</PickerItem>
              </Picker>
              <ActionButton
                onPress={() => {
                  setThemeChanged(true);
                  setDraft({
                    ...draft,
                    alarmMin: 45,
                    transitMin: 0,
                    gvTalkOn: true,
                    gvTalkMin: 25,
                    showPni: false,
                    theme: "system",
                  });
                }}
              >
                恢复默认设置
              </ActionButton>
              <TicketAccountsSection
                file={draft.accounts}
                onChange={(accounts) => setDraft((v) => ({ ...v, accounts }))}
              />
              <section className="danger-zone">
                <h2>清空数据</h2>
                <p className="muted">建议先在「导出与分享」中备份。</p>
                <div className="inline-actions">
                  <ClearDialog all={false} />
                  <ClearDialog all />
                </div>
              </section>
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              取消
            </Button>
            <Button
              onPress={() => {
                // 账号必填校验:没有用户名的账号在**读取归一**里会被丢掉
                // (`ticket-accounts.ts::normalizeAccountsFile`)—— 那会表现成「保存后账号凭空消失」。
                // 宁可在这儿明确挡下来,也不静默丢用户刚录入的东西。
                if (draft.accounts.accounts.some((account) => !account.username.trim())) {
                  ToastQueue.negative("每个票务账号都要填用户名（密码可以留空）", {
                    timeout: 5000,
                  });
                  return;
                }
                const patch: Partial<Settings> = {
                  alarmMin: Number.isFinite(draft.alarmMin)
                    ? Math.max(0, draft.alarmMin)
                    : 0,
                  transitMin: Number.isFinite(draft.transitMin)
                    ? Math.max(0, draft.transitMin)
                    : 0,
                  gvTalkOn: draft.gvTalkOn,
                  gvTalkMin: Number.isFinite(draft.gvTalkMin)
                    ? Math.max(0, Math.round(draft.gvTalkMin))
                    : 0,
                  showPni: draft.showPni,
                };
                if (themeChanged) patch.theme = draft.theme;
                setSettings(patch);
                // 账号落的是**另一只键**(`iffday.workspace.ticketaccounts.v1`,本地专属)
                setTicketAccounts(draft.accounts);
                ToastQueue.positive("设置已保存", { timeout: 5000 });
                close();
              }}
            >
              保存设置
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
