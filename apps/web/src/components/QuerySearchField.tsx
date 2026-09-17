/** 搜索框包装:**本地缓冲 + 延迟写 URL**(口径见 `app/query-search.ts`,2026-09-17)。
 *
 *  ★ 为什么需要这一层(用户报「搜索框无法输入中文」):
 *    直接把 `SearchField` 的 `value` 绑在 URL 上(`params.get("q")`)时,输入框的显示值永远
 *    慢 URL 一拍(router 导航是异步的),而中文输入法的拼音串是**组合态**,正靠这一拍活着 ——
 *    React 把 props.value 回写进 DOM 就把组合擦掉了,所以「能打英文、打不了中文」。
 *    改成输入框自己持有显示值(本地 state)、URL 只当持久化出口,组合态就没人来打断了。
 *
 *  ★ 三个使用点共用这一份实现(影片库 / 吃喝 / 红黑榜):缓冲、组合闸门、回声判定
 *    任一处口径变化都只该改一次(红线 5)。**过滤仍然读已提交的 URL 值**,本组件只管显示值。
 */

import { useEffect, useRef, useState } from "react";
import { SearchField, type TextFieldRef } from "./spectrum";
import { useQuery } from "../app/hooks";
import { createQueryCommitter } from "../app/query-search";

export function QuerySearchField({
  label,
  placeholder,
  param = "q",
}: {
  label: string;
  placeholder: string;
  /** URL 上的参数名。三个页面都用 `q`,留成参数只为将来复用。 */
  param?: string;
}) {
  const { params, update } = useQuery();
  const urlValue = params.get(param) ?? "";
  const [text, setText] = useState(urlValue);
  const inputRef = useRef<TextFieldRef>(null);
  // 输入法组合态。S2 的 `SearchFieldProps` 把 `GlobalDOMAttributes` 整个 Omit 掉了,
  // `onCompositionStart` 传不进 props,只能从 ref 拿原生 input 自己挂(见下面的 effect)。
  const composing = useRef(false);

  // 写 URL 的出口每次渲染都是新函数,放进 ref,好让调度器只建一次 ——
  // 否则每次渲染都重建,挂起的定时器会被丢掉。
  const commitRef = useRef<(value: string) => void>(() => {});
  useEffect(() => {
    // 一律 `replace`:搜索词是**同一页面的状态**,不是导航目的地。
    // (原先只有吃喝是 push,每按一个键就往历史栈塞一条,返回键要按 N 次才离得开。)
    commitRef.current = (value) => update({ [param]: value }, true);
  }, [update, param]);

  const [committer] = useState(() => createQueryCommitter((value) => commitRef.current(value)));

  // 外部导航改了 q(分享链接进来 / 别处清除筛选)→ 回写缓冲;
  // ⚠ **不能**把本地刚提交出去的那次回声也回写 —— 那会打断用户正在进行中的下一次输入,
  //    等于原 bug 换个地方复发(见 `query-search.ts` 的口径 ③)。
  useEffect(() => {
    if (committer.isEcho(urlValue)) return;
    setText((current) => (current === urlValue ? current : urlValue));
  }, [urlValue, committer]);

  // 组合期间必须挡住提交:拼音串是中间态,写进 URL 只会让地址栏抖动、列表被拼音过滤。
  useEffect(() => {
    const input = inputRef.current?.getInputElement();
    if (!input) return;
    const onCompositionStart = () => {
      composing.current = true;
    };
    const onCompositionEnd = () => {
      composing.current = false;
      // 上屏后的值以原生 input 为准:react-aria 这次 onChange 给的不一定是最新值
      const value = input.value;
      setText(value);
      committer.composeEnd(value);
    };
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    return () => {
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [committer]);

  // 卸载时丢掉挂起的提交:组件都没了,不该再导航
  useEffect(() => () => committer.dispose(), [committer]);

  return (
    <SearchField
      ref={inputRef}
      label={label}
      placeholder={placeholder}
      value={text}
      onChange={(value) => {
        setText(value);
        committer.type(value, composing.current);
      }}
    />
  );
}
