/** 搜索框「输入缓冲」的**唯一口径**(2026-09-17,`PLAN-20260917112233`)。
 *
 *  ★ 起因(用户提问「为什么搜索框无法输入中文?」):影片库 / 吃喝 / 红黑榜三个搜索框把 `SearchField`
 *    的 `value` 直接绑在 URL 上(`value={params.get("q") ?? ""}`),而 `onChange` 里的
 *    `setSearchParams` 是一次 **router 导航(异步)** —— 受控 input 的显示值于是永远慢一拍。
 *    中文输入法是**组合态**:拼音串暂存在 input 的 DOM 里,此刻 `input.value !== props.value`;
 *    React 每次提交都把 props.value 回写进 DOM,慢的这一拍正好把组合中的拼音串擦掉,
 *    所以「能打英文、打不了中文」(英文逐字符即时提交,回写值恰好等于刚敲的字符,看不出问题)。
 *    ⚠ 这不是猜测:`react-aria-components` 自己在 `TokenField` 里专门放了 `CompositionRenderBlocker`
 *      (源码注释 `Prevents React from re-rendering during composition events`),但普通
 *      TextField / SearchField 没有这层防护 —— 上游承认「组合期间重渲染会打断输入法」。
 *
 *  ★ 口径:输入框**自己持有显示值**(本地缓冲),URL 只当持久化出口 ——
 *    ① 输入不立刻写 URL,而是**延迟 `SEARCH_COMMIT_DELAY_MS` 合并提交**,把「每按一个键一次导航」
 *       收敛成「一次输入一次导航」;
 *    ② 输入法组合期间(`composing`) **一律不写** —— 拼音串是中间态,不是用户要搜的词,
 *       写进去只会让 URL 抖动、列表被拼音过滤;连挂起都不挂,否则失焦时的收尾提交会把
 *       "dianying" 这种拼音串落进 URL;
 *    ③ URL 反过来只在「**不是**本地刚提交出去的那次回声」时才回写缓冲(`isEcho`)——
 *       否则提交后的 URL 回声会把用户**正在进行中**的下一次输入打断,等于原 bug 换个地方复发。
 *
 *  ⚠ 本模块刻意**不碰 React / DOM**(定时器由 `setTimeout` 提供,测试用假时钟驱动),
 *    这样「先红后绿」的回归测试能在仓库既有的 node 环境里跑(见 `tests/query-search.test.ts`)。
 */

/** 从最后一次按键到写 URL 之间的合并等待(毫秒)。 */
export const SEARCH_COMMIT_DELAY_MS = 200;

export interface QueryCommitter {
  /** 用户输入了一个新值。`composing`(输入法组合中)时只取消挂起的提交,不安排新的。 */
  type(value: string, composing: boolean): void;
  /** 输入法组合结束:`value` 是**上屏后**的值,由它安排提交。 */
  composeEnd(value: string): void;
  /** URL 上的值变了 —— `true` 表示这是本地刚提交出去的回声,调用方**不要**回写缓冲。 */
  isEcho(urlValue: string): boolean;
  /** 丢弃挂起的提交(组件卸载:不该再触发导航)。 */
  dispose(): void;
}

/** 生成一个「延迟合并提交」调度器。
 *
 * @param commit 把值写进 URL 的出口(通常是 `update({ q })`)。
 * @param delay 合并等待,默认 {@link SEARCH_COMMIT_DELAY_MS}。
 */
export function createQueryCommitter(
  commit: (value: string) => void,
  delay: number = SEARCH_COMMIT_DELAY_MS,
): QueryCommitter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = "";
  let hasPending = false;
  // 最后一次真正写出去的值 —— 用来把自己的回声和「外部导航」区分开
  let lastCommitted: string | null = null;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function send(): void {
    clearTimer();
    if (!hasPending) return;
    hasPending = false;
    if (pending === lastCommitted) return;
    lastCommitted = pending;
    commit(pending);
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(send, delay);
  }

  return {
    type(value, composing) {
      if (composing) {
        // 组合中:取消挂起的提交,且**不**把它挂起来 —— 拼音串永远不该落到 URL 上
        clearTimer();
        hasPending = false;
        return;
      }
      if (value === lastCommitted && !hasPending) {
        // 值没变(如末尾加了空格又删掉):不必安排一次注定被丢弃的导航
        clearTimer();
        return;
      }
      pending = value;
      hasPending = true;
      schedule();
    },
    composeEnd(value) {
      pending = value;
      hasPending = true;
      schedule();
    },
    isEcho(urlValue) {
      return lastCommitted !== null && urlValue === lastCommitted;
    },
    dispose() {
      clearTimer();
      hasPending = false;
    },
  };
}
