/**
 * 管理后台（2026-09-23，PLAN-20260923142546，批 2）。
 *
 * 由来：用户要「一个能看到很多数据的管理后台」。服务端那半已在批 1 落地
 * （`/api/admin/{whoami,overview,rows,trends}`，两层门禁）。
 *
 * ★ 门禁的三态与一处刻意:
 *   `probeAdmin()` 把「没登录(401)」与「登录了但不是管理员(403)」分开 —— 两者的提示语完全不同，
 *   而前端**不抄一份白名单**（那既是第二份口径，也把名单给了所有人）。
 *   ⚠ 页面本身不是安全边界：真正的门禁在服务端；这里只是「别让人对着空白页猜」。
 *
 * ★ 视图切换走 `?tab=`（用既有的 `useQuery()`），不是嵌套路由：
 *   本轮刻意不动 `main.tsx` / `App.tsx`（另一个会话正在高频改前端），接线只留一行路由 +
 *   一条 fullPage 正则。URL 依然可分享、可收藏、可后退。
 *
 * ⚠ 渲染一律按「字段可能缺」写（`?? []`）：`admin-api.ts` 刻意不做逐字段白名单，理由见那里。
 */

import { useCallback, useEffect, useState } from "react";
import { openAccountPanel } from "../account";
import { onAccountChange } from "../account-sync";
import {
  loadAdminOverview,
  loadAdminRows,
  probeAdmin,
  type AdminOverview,
  type AdminProbe,
  type AdminRowPage,
} from "../admin-api";
import {
  ADMIN_ROWS_METRICS,
  ADMIN_TABS,
  adminTabLabel,
  adminTabOf,
  adminRowsMetricOf,
  auditHeadline,
  formatBytes,
  formatTime,
  formatWeight,
  metricLabel,
} from "../admin-view";
import { ActionButton, TextField } from "../components/spectrum";
import { useQuery } from "../app/hooks";
import "./admin.css";

/** 权限判定：loading → admin / guest / forbidden，另有「问不到」这一态（网络/超时）。 */
type Gate = "loading" | AdminProbe | "error";

export function AdminPage() {
  const { params, update } = useQuery();
  const tab = adminTabOf(params.get("tab"));
  const [gate, setGate] = useState<Gate>("loading");

  const probe = useCallback(() => {
    setGate("loading");
    probeAdmin()
      .then(setGate)
      // 网络错误/超时走这里：**不能**伪装成「你没权限」，那会把排查带偏
      .catch(() => setGate("error"));
  }, []);

  useEffect(() => probe(), [probe]);
  // 登录态一变就重新判定：刚登录成功 / 刚登出都该立刻反映，而不是等刷新
  useEffect(() => {
    const stop = onAccountChange(() => probe());
    return () => {
      stop();
    };
  }, [probe]);

  return (
    <div className="admin-page">
      <header className="admin-head">
        <h1 className="admin-title">管理后台</h1>
        <p className="admin-note text-12">
          仅白名单账号可见。这里能看到的是**聚合与身份**，不含任何人的片单内容。
        </p>
      </header>

      {gate === "loading" && <p className="admin-note">正在确认权限…</p>}

      {gate === "guest" && (
        <section className="admin-panel">
          <h2 className="admin-panel-title">需要登录</h2>
          <p className="admin-note">
            管理后台要求已登录的 IFFDAY 账号。登录后若仍看不到内容，说明这个账号不在管理员名单里。
          </p>
          <div className="admin-row-tools">
            <ActionButton onPress={() => openAccountPanel()}>登录 IFFDAY</ActionButton>
            <ActionButton onPress={probe}>重新确认</ActionButton>
          </div>
        </section>
      )}

      {gate === "forbidden" && (
        <section className="admin-panel">
          <h2 className="admin-panel-title">当前账号不是管理员</h2>
          <p className="admin-note">
            你的登录是有效的，但这个账号不在管理员名单里 —— 名单由服务端的
            `admin.ts::ADMIN_SUBJECTS` 决定，前端不参与判定。
          </p>
          <div className="admin-row-tools">
            <ActionButton onPress={() => openAccountPanel()}>切换账号</ActionButton>
          </div>
        </section>
      )}

      {gate === "error" && (
        <section className="admin-panel admin-panel--alert">
          <h2 className="admin-panel-title">暂时问不到服务端</h2>
          <p className="admin-note">
            可能是网络问题或服务端不可用 —— 这与「没有权限」是两件事，别混淆。
          </p>
          <div className="admin-row-tools">
            <ActionButton onPress={probe}>重试</ActionButton>
          </div>
        </section>
      )}

      {gate === "admin" && (
        <>
          <nav className="admin-tabs" aria-label="管理端视图">
            {ADMIN_TABS.map((name) => (
              <button
                key={name}
                type="button"
                className="admin-tab"
                aria-current={name === tab ? "page" : undefined}
                onClick={() => update({ tab: name === "overview" ? null : name })}
              >
                {adminTabLabel(name)}
              </button>
            ))}
          </nav>
          {tab === "overview" && <AdminOverviewView />}
          {tab === "rows" && <AdminRowsView />}
          {(tab === "trends" || tab === "content") && (
            <section className="admin-panel">
              <h2 className="admin-panel-title">{adminTabLabel(tab)}：还没做</h2>
              <p className="admin-note">
                服务端已经就绪（{tab === "trends" ? "/api/admin/trends" : "/api/discussions + /api/feedback"}），
                这一屏属于批 2 的第二片；本轮只交了「概览 + 明细」。
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- 概览 ---------------- */

function AdminOverviewView() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    loadAdminOverview()
      .then((next) => {
        setData(next);
        setError("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  if (loading && !data) return <p className="admin-note">正在加载概览…</p>;
  if (!data) {
    return (
      <section className="admin-panel admin-panel--alert">
        <h2 className="admin-panel-title">概览加载失败</h2>
        <p className="admin-note">{error || "未知错误"}</p>
        <div className="admin-row-tools">
          <ActionButton onPress={load}>重试</ActionButton>
        </div>
      </section>
    );
  }

  const audit = data.audit;
  return (
    <div className="admin-grid">
      <section className="admin-panel">
        <h2 className="admin-panel-title">数据总览（{data.edition}）</h2>
        <p className="admin-note text-12">
          服务端日界今天是 <b>{data.today}</b>（KST）。
          {data.earliestDay
            ? ` 趋势自 ${data.earliestDay} 起 —— 历史不回填。`
            : " 日账本还没有数据：趋势要从部署那一刻开始积累。"}
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>模块</th>
                <th className="num">记录</th>
                <th className="num">参与人数</th>
                <th className="num">目标数</th>
                <th className="num">累计</th>
                <th className="num">今日增量</th>
              </tr>
            </thead>
            <tbody>
              {(data.metrics ?? []).map((row) => (
                <tr key={row.metric}>
                  <td>{metricLabel(row.metric)}</td>
                  <td className="num">{row.rows}</td>
                  <td className="num">{row.contributors}</td>
                  <td className="num">{row.targets}</td>
                  <td className="num">{formatWeight(row.total)}</td>
                  <td className="num">{formatWeight(row.today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="admin-note text-12">
          权重口径：登录 1.0 / 匿名 0.75（红黑榜一人一票、不加权，所以那一行是整数票数）。
        </p>
        <div className="admin-row-tools">
          <ActionButton onPress={load}>刷新</ActionButton>
        </div>
      </section>

      <section className={`admin-panel${audit?.ok ? "" : " admin-panel--alert"}`}>
        <h2 className="admin-panel-title">数据体检（聚合对账）</h2>
        <p className="admin-note">{auditHeadline(audit)}</p>
        <p className="admin-note text-12">
          做法：把每张**贡献表**现算一遍，与读侧真正用的**预聚合表**逐项比。
          聚合表一旦漂移，榜单照常显示、只是数字错了 —— 读侧永远看不出来，所以要有这一屏。
        </p>
        {audit && !audit.ok && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>模块</th>
                  <th>目标</th>
                  <th className="num">贡献表现算</th>
                  <th className="num">聚合表存储</th>
                </tr>
              </thead>
              <tbody>
                {audit.drifts.map((drift) => (
                  <tr key={`${drift.metric}|${drift.key}`}>
                    <td>{metricLabel(drift.metric)}</td>
                    <td className="admin-mono">{drift.key}</td>
                    <td className="num">{formatWeight(drift.contribution)}</td>
                    <td className="num">{formatWeight(drift.stat)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="admin-note text-12">
          扫描行数：
          {Object.entries(audit?.scanned ?? {})
            .map(([table, count]) => `${table} ${count}`)
            .join(" · ") || "—"}
        </p>
        <p className="admin-note text-12">
          对账**只报告不修**：修法是重算聚合（属写路径），不该由一个体检接口顺手做 ——
          否则「谁在什么时候把数字改回去了」就没人知道。
        </p>
      </section>

      <section className="admin-panel">
        <h2 className="admin-panel-title">账号与内容</h2>
        <p className="admin-note text-12">
          ⚠ 账号这块**只回统计量**：片单内容属于账号自己，管理端永远不读。
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <tbody>
              <tr>
                <td>有效会话</td>
                <td className="num">{data.accounts?.sessions ?? 0}</td>
              </tr>
              <tr>
                <td>同步文档</td>
                <td className="num">{data.accounts?.documents ?? 0}</td>
              </tr>
              <tr>
                <td>文档体积</td>
                <td className="num">{formatBytes(data.accounts?.documentBytes ?? 0)}</td>
              </tr>
              <tr>
                <td>已导入账号</td>
                <td className="num">{data.accounts?.imported ?? 0}</td>
              </tr>
              <tr>
                <td>场次讨论帖</td>
                <td className="num">{data.content?.discussions ?? 0}</td>
              </tr>
              <tr>
                <td>反馈留言</td>
                <td className="num">{data.content?.feedback ?? 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ---------------- 明细（通用贡献行） ---------------- */

function AdminRowsView() {
  const { params, update } = useQuery();
  const metric = adminRowsMetricOf(params.get("metric"));
  const query = params.get("q") ?? "";
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // 游标栈：服务端只给「下一页」，但要能退回上一页，所以自己记住走过的游标
  const [trail, setTrail] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState<AdminRowPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (nextCursor: string | undefined, keyword: string, which: string) => {
      setLoading(true);
      loadAdminRows({ metric: which, cursor: nextCursor, query: keyword || undefined, limit: 50 })
        .then((result) => {
          setPage(result);
          setError("");
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "加载失败"))
        .finally(() => setLoading(false));
    },
    [],
  );

  // 换模块或换筛选词 = 回到第一页（旧游标属于另一份结果集，带过去必然错位）
  useEffect(() => {
    setTrail([undefined]);
    setCursor(undefined);
    load(undefined, query, metric);
  }, [metric, query, load]);

  const goPage = (next: string | undefined, index: number) => {
    setCursor(next);
    setTrail((previous) => [...previous.slice(0, index + 1), next]);
    load(next, query, metric);
  };

  const currentIndex = trail.indexOf(cursor);

  return (
    <section className="admin-panel">
      <h2 className="admin-panel-title">贡献行明细</h2>
      <div className="admin-row-tools">
        {ADMIN_ROWS_METRICS.map((name) => (
          <button
            key={name}
            type="button"
            className="admin-tab"
            aria-current={name === metric ? "page" : undefined}
            onClick={() => update({ metric: name, tab: "rows" })}
          >
            {metricLabel(name)}
          </button>
        ))}
      </div>
      <div className="admin-row-tools">
        <TextField
          value={query}
          aria-label="按目标名筛选"
          placeholder="按目标名筛选（片 key / 场次 code / 路由）"
          // ⚠ S2 的 `TextField.onChange` 直接给**字符串**（不是 DOM 事件）—— 与原生 input 不同
          onChange={(value) => update({ q: value || null })}
        />
        <ActionButton onPress={() => load(cursor, query, metric)}>刷新</ActionButton>
      </div>

      {error && <p className="admin-note admin-error">加载失败：{error}</p>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>目标</th>
              <th>子维度</th>
              <th>贡献者</th>
              <th className="num">权重 / 票</th>
              <th className="num">次数</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {(page?.rows ?? []).map((row) => (
              <tr key={`${row.target}|${row.sub ?? ""}|${row.contributor}`}>
                <td className="admin-mono">{row.target}</td>
                <td>{row.sub ? metricLabel(row.sub) : "—"}</td>
                <td className="admin-mono">
                  {row.contributor}
                  {row.anonymous ? "（匿名）" : ""}
                </td>
                <td className="num">{formatWeight(row.weight)}</td>
                <td className="num">{row.hits === null ? "—" : formatWeight(row.hits)}</td>
                <td>{formatTime(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="admin-note text-12">
        {loading ? "正在加载…" : `本页 ${page?.rows.length ?? 0} 行`} ·
        参与人数按身份去重：`anon:` 前缀是匿名浏览器的哈希，不是账号。
      </p>
      <div className="admin-row-tools">
        <ActionButton
          isDisabled={currentIndex <= 0}
          onPress={() => {
            if (currentIndex > 0) goPage(trail[currentIndex - 1], currentIndex - 1);
          }}
        >
          上一页
        </ActionButton>
        <ActionButton
          isDisabled={!page?.nextCursor}
          onPress={() => {
            if (page?.nextCursor) goPage(page.nextCursor, currentIndex + 1);
          }}
        >
          下一页
        </ActionButton>
      </div>
    </section>
  );
}
