import { useState } from "react";
import { matchScreenings } from "../app/schedule-search";
import { useCatalog } from "../app/store";
import { venueShort } from "../legend";
import { mergeScreenings, slotOf, store, toggleScreening } from "../state";
import { dateInfo, displayTitle, filmNodeKey } from "../util";
import { SCHEDULED_STATE, SCHEDULE_LABEL } from "../actions-copy";
import type { Screening } from "../types";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
  SearchField,
  ToastQueue,
} from "./spectrum";
import "./screening-social.css";

/** 「我的行程」顶部的「添加转票场次」入口。 */
export function TransferAddEntry() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        // 每次打开都重挂载:清空关键词(与 GvDurationButton 同一手法)
        if (next) setSession((n) => n + 1);
        setOpen(next);
      }}
    >
      <ActionButton>添加转票场次</ActionButton>
      {/* DialogTrigger 无条件渲染 children,故只在打开时挂载(与 GvDurationButton 同一手法) */}
      {open && <TransferAddDialog key={session} />}
    </DialogTrigger>
  );
}

/** 编号 token 化:按空白 / 半角逗号 / 全角逗号 / 顿号切分,去重保序。
 *  ⚠ 用户常从聊天记录里直接粘一串(「419、033 001」),所以分隔符要一次认全 ——
 *    漏掉顿号会让整串变成一个 token,匹配不到任何场次。 */
function splitTokens(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(/[\s,，、]+/)) {
    const token = raw.trim();
    if (token) seen.add(token);
  }
  return [...seen];
}

/** 官方场次编号**精确匹配**,允许省略前导零(`1` 与 `001` 指向同一场)。
 *  ⚠ 只对**纯数字** token 做数值比较:官方编号是 3 位数字,含字母的 token 一律原样比对,
 *    免得把片名(如「2046」这部电影的中文名)误当成编号。 */
function codeHit(all: readonly Screening[], token: string): Screening | undefined {
  const exact = all.find((s) => s.code === token);
  if (exact) return exact;
  if (!/^\d+$/.test(token)) return undefined;
  const value = Number(token);
  return all.find((s) => /^\d+$/.test(s.code) && Number(s.code) === value);
}

/** 「添加转票场次」(2026-09-30 改版,`PLAN-20260930213528`)。
 *
 * ★ 形态:**编号为主,搜索兜底** —— 用户口径是「改成通过 Code 添加」。
 *   · 输入按分隔符切成一串 token,逐个做**编号精确匹配**;
 *   · 全部纯数字 token 都命中 → 顶部给一枚「加入这 N 场」按钮,**一次全部记入行程**;
 *   · 命中不了 / 输入的是片名 → 走 `matchScreenings` 的模糊检索候选列表,逐行添加;
 *   · 编号 token 没匹配到时单独提示(片名匹配不到不必提示 —— 候选列表空着本身已经是反馈)。
 * ★ **不再写任何票务状态**:三态(`biff.tickets.v1`)随卡片视图一起下线,本入口现在只做一件事 ——
 *   把别人转给你的那一场放进行程。 */
function TransferAddDialog() {
  const { cat, keyOf } = useCatalog();
  const [query, setQuery] = useState("");
  const all = cat.schedule.screenings;
  const tokens = splitTokens(query);
  const hits: Screening[] = [];
  for (const token of tokens) {
    const hit = codeHit(all, token);
    if (hit && !hits.some((s) => s.code === hit.code)) hits.push(hit);
  }
  // 只提示**编号**没匹配到:片名匹配不到时下面那张候选列表空着,本身就是反馈。
  const missingCodes = tokens.filter((t) => /^\d+$/.test(t) && !codeHit(all, t));
  // 候选列表 = 模糊检索(编号片段 / 片名)兜底;多个 token 的结果并集去重。
  const candidates = [
    ...new Map(tokens.flatMap((t) => matchScreenings(all, t)).map((s) => [s.code, s])).values(),
  ];
  // 清一色命中编号时不再铺候选列表:同一个场次会在「批量按钮 + 列表行」里出现两次,
  // 而这时用户的意图已经明确(他输的就是编号),多一份入口只会让他犹豫点哪个。
  const codesOnly = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t)) && missingCodes.length === 0;

  const mark = (s: Screening) => {
    // ⚠ 顺序要紧:先「加入行程」(会 rebuildIndex → prune 掉不在行程里的票据明细)。
    if (!slotOf(s.code)) toggleScreening(filmNodeKey(cat, s), s.code);
    ToastQueue.positive(`${s.code} 已记入行程（转票）`);
  };

  /** 批量入口:**一次落盘**(逐个 `toggleScreening` 会写 N 次盘、广播 N 次重绘)。 */
  const markAll = () => {
    const fresh = hits.filter((s) => !slotOf(s.code));
    if (fresh.length) mergeScreenings(fresh.map((s) => s.code), keyOf);
    ToastQueue.positive(
      fresh.length
        ? `已记入 ${hits.length} 场（转票）`
        : `这 ${hits.length} 场已经在行程里了`,
    );
    setQuery("");
  };

  return (
    <Dialog size="M">
      {({ close }) => (
        <>
          <Heading slot="title">添加转票场次</Heading>
          <Content>
            <div className="transfer-dialog">
              <p className="transfer-hint">
                收到别人转的票？输入场次编号即可一步记入行程，多枚编号用空格或逗号隔开（如「419 033」）；
                记不清编号时也可以按片名搜索。
              </p>
              <SearchField
                label="场次编号或片名"
                placeholder="如 419 / 419 033 / 峡湾 / Fjord"
                value={query}
                onChange={setQuery}
              />
              {missingCodes.length > 0 && (
                <p className="transfer-hint">
                  没找到编号 {missingCodes.join("、")}。编号写官方 3 位（如 001），片名中英文都可以。
                </p>
              )}
              {hits.length > 0 && (
                <div className="transfer-batch">
                  <ActionButton onPress={markAll}>
                    {hits.length === 1 ? SCHEDULE_LABEL : `排进这 ${hits.length} 场`}
                  </ActionButton>
                  <span className="transfer-hint">{hits.map((s) => s.code).join("、")}</span>
                </div>
              )}
              {!codesOnly && (
                <ul className="transfer-list">
                  {candidates.map((s) => {
                    const venue = cat.venueById.get(s.venue_id);
                    const inPlan = Boolean(slotOf(s.code));
                    return (
                      <li className="transfer-row" key={s.code} data-transfer-code={s.code}>
                        <div className="transfer-row-main">
                          <strong>{displayTitle(s, store.mappings.get(s.code)?.title_cn)}</strong>
                          <span>
                            {s.code} · {dateInfo(s.date).label} {s.start_time.slice(0, 5)} ·{" "}
                            {venue ? venueShort(venue) : s.venue_display}
                            {inPlan ? " · 已在行程" : ""}
                          </span>
                        </div>
                        {/* aria-label 必须**含可见文案**(无障碍的 label-in-name):
                            只写「把场次 004 记入行程」会让按可见文字操作的语音用户点不到它。
                            已在行程的行直接**禁用**:三态下线后这个入口只做「加入」一件事,
                            再点一次没有可切换的状态(禁用比给一个点了没反应的按钮诚实)。 */}
                        <ActionButton
                          isDisabled={inPlan}
                          aria-label={`${inPlan ? SCHEDULED_STATE : SCHEDULE_LABEL} 场次 ${s.code}`}
                          onPress={() => mark(s)}
                        >
                          {inPlan ? SCHEDULED_STATE : SCHEDULE_LABEL}
                        </ActionButton>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              完成
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
