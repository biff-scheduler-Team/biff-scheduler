// /api/plan — 我的排片列表
// Pages Functions: functions/api/plan.js
export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT code, group_tag, priority, note, updated_at FROM user_plan WHERE user_id = ? ORDER BY code"
    )
      .bind("me")
      .all();
    return Response.json({ ok: true, data: results });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
