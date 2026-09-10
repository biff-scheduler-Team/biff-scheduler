// /api/pick — 我的选片列表(一部片一条记录)
// Pages Functions: functions/api/pick.js
export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT film_key, priority, note, picks, updated_at FROM user_pick WHERE user_id = ? ORDER BY film_key"
    )
      .bind("me")
      .all();
    return Response.json({ ok: true, data: results });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
