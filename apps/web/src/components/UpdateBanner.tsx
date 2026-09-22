// 发版后的顶部提示条(2026-09-22,PLAN-20260922100704)。
//
// 只在「新版已接管本页」时出现,且**不自动刷新** —— 排片排到一半被强刷会把上下文打断,
// 用户点了「刷新」才 reload。点「稍后」只收掉本会话的这一条;同一会话里再发一版不再弹,
// 下次自然加载就已经是新版了(见 `pwa-update.ts` 的幂等说明)。
//
// 状态来源是 `pwa-update.ts` 的模块单例,而不是本组件的 effect:
// 监听必须在 `registerSW.js` 注册之前挂上,那个时机在 React 渲染之前就到了。

import { useState, useSyncExternalStore } from "react";
import {
  getUpdateAvailable,
  reloadForUpdate,
  subscribeUpdateAvailable,
} from "../pwa-update";

export function UpdateBanner() {
  const available = useSyncExternalStore(subscribeUpdateAvailable, getUpdateAvailable);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">有新版本可用</span>
      <button type="button" className="update-banner-refresh" onClick={reloadForUpdate}>
        刷新
      </button>
      <button type="button" className="update-banner-dismiss" onClick={() => setDismissed(true)}>
        稍后
      </button>
    </div>
  );
}
