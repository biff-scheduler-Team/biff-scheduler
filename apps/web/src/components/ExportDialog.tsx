import { download } from "../app/download";
export { download } from "../app/download";
import { PosterPreview } from "./PosterPreview";
import { buildPosterModel, type PosterModel } from "../poster";
import { dateInfo } from "../util";
import type { Catalog } from "../types";
import type { SavedPlan } from "../state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Checkbox,
  Content,
  Dialog,
  Heading,
  Picker,
  PickerItem,
  TextArea,
  ToastQueue,
} from "./spectrum";
import { useCatalog } from "../app/store";
import { buildIcs, type PickRow } from "../ics";
import { buildShareText } from "../share";
import { parseBackupText, parseIcsCodes, restore, snapshot } from "../backup";
import {
  mergeScreenings,
  replaceScreenings,
  savedPlans,
  slotOf,
  store,
} from "../state";
import { talkOnOf } from "../gv";
import { todayIsoLocal } from "../util";
import { copyText } from "../clipboard";
import { groupMatesOf } from "../plans";
import { batchHeading, programOf } from "../extras";
import { ticketBatchOf } from "../batch";

export function planOutline(cat: Catalog, plan: SavedPlan): string {
  const shows = plan.codes
    .flatMap((code) => {
      const s = cat.byCode.get(code);
      return s ? [s] : [];
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start_time.localeCompare(b.start_time),
    );
  const parts = [`${shows.length} 场`];
  if (shows.length) {
    const first = dateInfo(shows[0].date).label;
    const last = dateInfo(shows.at(-1)!.date).label;
    parts.push(first === last ? first : `${first}–${last}`);
  }
  const missing = plan.codes.length - shows.length;
  if (missing) parts.push(`${missing} 场已不在排期`);
  return parts.join("，");
}

function ImportData() {
  const { cat, keyOf } = useCatalog();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const ics = /BEGIN:VCALENDAR/i.test(text);
  const parsed = ics ? parseIcsCodes(text) : parseBackupText(text);
  const validCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.filter((c) => cat.byCode.has(c))
      : [];
  const unknownCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.length - validCodes.length
      : 0;
  const importText = (value: string) => {
    if (value === text) return;
    setText(value);
    setError("");
    setConfirmed(false);
  };
  const apply = (mode: "merge" | "replace") => {
    if (!parsed.ok) return;
    try {
      if ("data" in parsed) {
        restore(localStorage, parsed.data);
        window.dispatchEvent(new Event("iffday:workspace-change"));
        location.reload();
      } else {
        if (mode === "merge") mergeScreenings(validCodes, keyOf);
        else replaceScreenings(validCodes, keyOf);
        ToastQueue.positive(`已导入 ${validCodes.length} 场`, {
          timeout: 5000,
        });
        importText("");
      }
    } catch {
      setError(
        "写入失败，浏览器存储可能已满。请保留备份文件，释放空间后重试。",
      );
    }
  };
  return (
    <section className="import-data">
      <h2>导入备份或日历</h2>
      <label className="file-label">
        选择 JSON 或 ICS 文件
        <input
          aria-label="选择备份或日历文件"
          type="file"
          accept=".json,.ics,application/json,text/calendar"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void file
                .text()
                .then(importText)
                .catch(() => setError("文件读取失败，请重新选择。"));
            e.target.value = "";
          }}
        />
      </label>
      <TextArea label="或粘贴备份内容" value={text} onChange={importText} />
      {text && !parsed.ok && (
        <p role="alert" className="error-text">
          {parsed.error.replaceAll(" —— ", "，")}
        </p>
      )}
      {parsed.ok && (
        <div className="import-preview">
          <p>
            {"data" in parsed
              ? `找到 ${Object.keys(parsed.data).length} 项本机数据。恢复将整体替换当前数据。`
              : `识别到 ${validCodes.length} 场${unknownCodes ? `，${unknownCodes} 场已不在当前排期，会跳过` : ""}。`}
          </p>
          {"data" in parsed ? (
            <>
              {!confirmed ? (
                <ActionButton onPress={() => setConfirmed(true)}>
                  准备恢复备份
                </ActionButton>
              ) : (
                <div className="notice">
                  <p>当前选片、备注、设置和方案将被这份备份替换。</p>
                  <Button variant="negative" onPress={() => apply("replace")}>
                    确认恢复并刷新
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="inline-actions">
              <Button
                isDisabled={!validCodes.length}
                onPress={() => apply("merge")}
              >
                合并到当前行程
              </Button>
              {confirmed ? (
                <Button
                  variant="negative"
                  isDisabled={!validCodes.length}
                  onPress={() => apply("replace")}
                >
                  确认替换行程
                </Button>
              ) : (
                <ActionButton
                  isDisabled={!validCodes.length}
                  onPress={() => setConfirmed(true)}
                >
                  替换已排场次
                </ActionButton>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function ExportDialog() {
  const { cat, plans } = useCatalog();
  const [planId, setPlanId] = useState(savedPlans.at(-1)?.id ?? "");
  const [preview, setPreview] = useState(false);
  // 「带上顺位」/「带上开票批次」:分享文案的两个可选扩展(见 share.ts 的 ShareOptions)。
  // 默认关 —— 关掉时输出就是「CODE 前置 + 两行一场」的基线版式,与旧版逐字一致(除 CODE 位置)。
  const [withRank, setWithRank] = useState(false);
  const [withBatch, setWithBatch] = useState(false);
  const generation = useRef(0);
  const [image, setImage] = useState<{
    id: number;
    planId: string;
    model: PosterModel;
    loading: boolean;
  } | null>(null);
  const plan = savedPlans.find((p) => p.id === planId) ?? savedPlans.at(-1);
  const effectivePlanId = plan?.id;
  const activeImage = image?.planId === effectivePlanId ? image : null;
  useEffect(() => {
    // Storage sync may remove the selected plan without a Picker change event.
    setImage((current) => current?.planId === effectivePlanId ? current : null);
  }, [effectivePlanId]);
  const onImageLoadingChange = useCallback((id: number, loading: boolean) => {
    setImage((current) => current?.id === id ? { ...current, loading } : current);
  }, []);
  const rows: PickRow[] = (plan?.codes ?? [])
    .filter((c) => cat.byCode.has(c))
    .map((code) => ({
      code,
      note: store.picks.get(slotOf(code)?.key ?? "")?.note ?? "",
    }));
  // 备选来自**当前行程**的冲突组(方案快照每组只留第 1 顺位,拿它印顺位恒为「顺位 1」)
  const groupMates = useMemo(() => groupMatesOf(plans.groups), [plans.groups]);
  const share = buildShareText(cat, rows, store.mappings, talkOnOf, {
    ranking: withRank
      ? { rankOf: plans.rankOf, matesOf: (code) => groupMates.get(code) ?? [] }
      : undefined,
    batching: withBatch
      ? {
          batchOf: (s) => ticketBatchOf(s, { kindOf: (code) => programOf(code)?.kind }),
          headOf: (batch) => batchHeading(cat.schedule.festival.year, batch),
        }
      : undefined,
  });
  const buildImage = () => {
    const model = buildPosterModel(cat, rows, store.mappings, talkOnOf);
    if (!model || !plan) return;
    setImage({
      id: ++generation.current,
      planId: plan.id,
      model,
      loading: true,
    });
  };
  return (
    <Dialog size="L">
      {({ close }) => (
        <>
          <Heading slot="title">导出与分享</Heading>
          <Content>
            <div className="export-content">
              {savedPlans.length ? (
                <section className="form-stack">
                  <Picker
                    label="导出方案"
                    value={plan?.id ?? ""}
                    onChange={(id) => {
                      setPlanId(String(id));
                      setImage(null);
                    }}
                  >
                    {savedPlans.map((p) => (
                      <PickerItem key={p.id} id={p.id}>
                        {p.name}（{planOutline(cat, p)}）
                      </PickerItem>
                    ))}
                  </Picker>
                  <p className="muted">
                    {rows.length} 场有效排期。日历时间会自动转换到手机所在时区。
                  </p>
                  <Checkbox isSelected={withRank} onChange={setWithRank}>
                    带上顺位（含备选场次）
                  </Checkbox>
                  {withRank && !plans.groups.length && (
                    <p className="muted">
                      当前行程没有时间重叠的场次，顺位不会有内容。
                    </p>
                  )}
                  <Checkbox isSelected={withBatch} onChange={setWithBatch}>
                    带上开票批次（第 1 批 / 第 2 批分节）
                  </Checkbox>
                  <div className="inline-actions">
                    <Button
                      isDisabled={!rows.length}
                      onPress={() =>
                        download(
                          buildIcs(
                            cat,
                            rows,
                            store.mappings,
                            store.settings.alarmMin,
                            talkOnOf,
                          ),
                          "biff2026.ics",
                          "text/calendar;charset=utf-8",
                        )
                      }
                    >
                      导出 ICS 日历
                    </Button>
                    <ActionButton
                      isDisabled={!rows.length}
                      onPress={() => {
                        setPreview(true);
                        void copyText(share).then((ok) =>
                          ok
                            ? ToastQueue.positive("文案已复制", {
                                timeout: 5000,
                              })
                            : ToastQueue.negative(
                                "复制失败，可以在预览中手动复制。",
                              ),
                        );
                      }}
                    >
                      分享文案
                    </ActionButton>
                    <ActionButton
                      isDisabled={!rows.length}
                      isPending={activeImage?.loading ?? false}
                      onPress={() => {
                        void buildImage();
                      }}
                    >
                      生成分享图片
                    </ActionButton>
                  </div>
                  {preview && (
                    <div className="form-stack">
                      <TextArea label="行程分享文案" value={share} isReadOnly />
                      <ActionButton
                        onPress={() => {
                          void copyText(share).then((ok) =>
                            ok
                              ? ToastQueue.positive("文案已复制", {
                                  timeout: 5000,
                                })
                              : ToastQueue.negative(
                                  "复制失败，可以选择上方文案手动复制。",
                                ),
                          );
                        }}
                      >
                        复制文案
                      </ActionButton>
                    </div>
                  )}
                  {activeImage && (
                    <PosterPreview
                      key={activeImage.id}
                      generationId={activeImage.id}
                      model={activeImage.model}
                      onLoadingChange={onImageLoadingChange}
                    />
                  )}
                </section>
              ) : (
                <div className="notice">
                  <h2>先保存一个方案</h2>
                  <p>
                    在「我的行程」点击「保存当前方案」，再导出日历或分享图片。
                  </p>
                </div>
              )}
              <section className="backup-section">
                <h2>数据备份</h2>
                <p className="muted">
                  备份包括选片、备注、顺位、已保存方案和设置。换设备或域名时可以导入恢复。
                </p>
                <ActionButton
                  onPress={() => {
                    try {
                      download(
                        JSON.stringify(
                          snapshot(localStorage, new Date(), location.origin),
                          null,
                          2,
                        ),
                        `biff-backup-${todayIsoLocal()}.json`,
                        "application/json",
                      );
                    } catch {
                      ToastQueue.negative(
                        "无法读取本机数据，请检查浏览器存储权限。",
                      );
                    }
                  }}
                >
                  导出数据备份
                </ActionButton>
              </section>
              <ImportData />
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              关闭
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
