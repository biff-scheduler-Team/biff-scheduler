// /api/plan/:code — 单场次 upsert / 删除
// Pages Functions: functions/api/plan/[code].js
const VALID_GROUP = new Set(["A", "B"]);
const VALID_PRIORITY = new Set(["must", "maybe", "wild"]);

export async function onRequestPut({ env, params, request }) {
  const code = String(params.code || "");
  if (!/^\d{3}$/.test(code)) {
    return Response.json({ ok: false, error: "code 需为 3 位数字" }, { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body 需为 JSON" }, { status: 400 });
  }
  const group_tag = String(body.group_tag ?? "A").toUpperCase();
  const priority = String(body.priority ?? "maybe").toLowerCase();
  if (!VALID_GROUP.has(group_tag)) {
    return Response.json({ ok: false, error: "group_tag 仅支持 A/B" }, { status: 400 });
  }
  if (!VALID_PRIORITY.has(priority)) {
    return Response.json({ ok: false, error: "priority 仅支持 must/maybe/wild" }, { status: 400 });
  }
  const note = String(body.note ?? "").slice(0, 200);

  await env.DB.prepare(
    `INSERT INTO user_plan (user_id, code, group_tag, priority, note, updated_at)
     VALUES ('me', ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, code)
     DO UPDATE SET group_tag = excluded.group_tag,
                   priority = excluded.priority,
                   note = excluded.note,
                   updated_at = datetime('now')`
  )
    .bind(code, group_tag, priority, note)
    .run();

  return Response.json({ ok: true, data: { code, group_tag, priority, note } });
}

export async function onRequestDelete({ env, params }) {
  const code = String(params.code || "");
  await env.DB.prepare("DELETE FROM user_plan WHERE user_id = 'me' AND code = ?").bind(code).run();
  return Response.json({ ok: true, data: { code } });
}
