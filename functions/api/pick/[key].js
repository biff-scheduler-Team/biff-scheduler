// /api/pick/:key — 单条选片记录 upsert / 删除
// Pages Functions: functions/api/pick/[key].js
// key = filmNodeKey:`cat:f001` 或 `sched:<片名小写>`(后者含中文 → 前端 encodeURIComponent)
const VALID_PRIORITY = new Set(["must", "maybe", "wild"]);
const VALID_GROUP = new Set(["A", "B"]);
const MAX_PICKS = 500; // 单条记录场次上限:防脏载荷把行撑爆

/** 路径参数解码:Pages 通常已解码,但对含 % 的片名可能仍是被编码态 → 容错再解一次 */
function decodeKey(raw) {
  const s = String(raw || "");
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function onRequestPut({ env, params, request }) {
  const film_key = decodeKey(params.key).trim();
  if (!/^(cat:f\d{3}|sched:.+)$/.test(film_key)) {
    return Response.json({ ok: false, error: "film_key 需为 cat:f### 或 sched:<片名>" }, { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body 需为 JSON" }, { status: 400 });
  }

  // priority 三态:
  //   null      → SQL NULL(前端「未设档位」,必须原样落库,否则云端会把未设覆盖回 maybe)
  //   undefined → 兼容旧客户端 / 异常载荷,沿用历史默认 'maybe'
  //   字符串     → 校验 must|maybe|wild
  const rawPriority = body.priority;
  const priority = rawPriority === null ? null : String(rawPriority ?? "maybe").toLowerCase();
  if (priority !== null && !VALID_PRIORITY.has(priority)) {
    return Response.json({ ok: false, error: "priority 仅支持 must/maybe/wild 或 null" }, { status: 400 });
  }
  const note = String(body.note ?? "").slice(0, 200);

  // picks 归一化:只留 {code:3 位数字, group:'A'|'B'},同场去重
  const seen = new Set();
  const picks = [];
  for (const p of Array.isArray(body.picks) ? body.picks : []) {
    const code = String(p?.code ?? "");
    const group = String(p?.group ?? "").toUpperCase();
    if (!/^\d{3}$/.test(code) || !VALID_GROUP.has(group) || seen.has(code)) continue;
    seen.add(code);
    picks.push({ code, group });
    if (picks.length >= MAX_PICKS) break;
  }
  const picksJson = JSON.stringify(picks);

  await env.DB.prepare(
    `INSERT INTO user_pick (user_id, film_key, priority, note, picks, updated_at)
     VALUES ('me', ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, film_key)
     DO UPDATE SET priority = excluded.priority,
                   note = excluded.note,
                   picks = excluded.picks,
                   updated_at = datetime('now')`
  )
    .bind(film_key, priority, note, picksJson)
    .run();

  return Response.json({ ok: true, data: { film_key, priority, note, picks: picksJson } });
}

export async function onRequestDelete({ env, params }) {
  const film_key = decodeKey(params.key).trim();
  await env.DB.prepare("DELETE FROM user_pick WHERE user_id = 'me' AND film_key = ?").bind(film_key).run();
  return Response.json({ ok: true, data: { film_key } });
}
