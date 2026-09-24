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
  ToastQueue,
} from "./spectrum";
import {
  clearAllPicks,
  clearScreeningSlots,
  setSettings,
  store,
} from "../state";
import type { Settings, ThemePref } from "../types";

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
