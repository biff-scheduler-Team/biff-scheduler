// /api/mapping — 豆瓣映射全量(供前端一次性拉取合并)
// Pages Functions: functions/api/mapping.js
export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT code, subject_id, title_cn, douban_url, updated_at FROM douban_map ORDER BY code"
    ).all();
    return Response.json({ ok: true, data: results });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
