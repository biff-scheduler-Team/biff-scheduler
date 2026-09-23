// 发版后的顶部提示条(2026-09-22,PLAN-20260922100704)。
//
// 只在「新版已接管本页」时出现,且**不自动刷新** —— 排片排到一半被强刷会把上下文打断,
// 用户点了「刷新」才 reload。点「稍后」只收掉本会话的这一条;同一会话里再发一版不再弹,
// 下次自然加载就已经是新版了(见 `pwa-update.ts` 的幂等说明)。
//
// 状态来源是 `pwa-update.ts` 的模块单例,而不是本组件的 effect:
// 监听必须在 `registerSW.js` 注册之前挂上,那个时机在 React 渲染之前就到了。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getUpdateAvailable,
  reloadForUpdate,
  subscribeUpdateAvailable,
} from "../pwa-update";

export function UpdateBanner() {
  const available = useSyncExternalStore(subscribeUpdateAvailable, getUpdateAvailable);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed) return null;
  return <UpdateBannerBar onDismiss={() => setDismissed(true)} />;
}

/**
 * 真的显示出来的那一条。
 *
 * 单独拆一层是为了**只在显示时**挂 ResizeObserver:这条 banner 是 sticky + `top: 0`
 * (见 `style.css` 的 `.update-banner`),键盘焦点滚进视口时会落在它下面 ——
 * WCAG 2.2 AA「Focus Not Obscured (Minimum)」要求用 `scroll-padding-top` 留位。
 * 留多少不能写死:这条 `flex-wrap: wrap`,窄屏会折成两行。
 * 所以在这里实测高度并写回 `--update-banner-h`,由 CSS 侧的
 * `html:has(.update-banner)` 消费(2026-09-23,`PLAN-20260923122500` T2)。
 */
function UpdateBannerBar({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const publish = () => {
      document.documentElement.style.setProperty("--update-banner-h", `${node.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      // 卸载时必须撤掉:留着它,下次这条出现前会先按旧高度跳一下
      document.documentElement.style.removeProperty("--update-banner-h");
    };
  }, []);
  return (
    <div className="update-banner" ref={ref} role="status">
      <span className="update-banner-text">有新版本可用</span>
      <button type="button" className="update-banner-refresh" onClick={reloadForUpdate}>
        刷新
      </button>
      <button type="button" className="update-banner-dismiss" onClick={onDismiss}>
        稍后
      </button>
    </div>
  );
}
