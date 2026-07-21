// トークンを検証する共通関数
async function authenticate(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    
    const token = authHeader.split(" ")[1];
    // トークンに紐づくユーザー名を取得
    const username = await env.QUIZ_DB.get(`session:${token}`);
    return username;
}

// データ読み込み (GET /api/data)
export async function onRequestGet(context) {
    const { request, env } = context;
    const username = await authenticate(request, env);
    if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

    // data:ユーザー名 のキーでデータを取得
    const data = await env.QUIZ_DB.get(`data:${username}`);
    
    // データがまだない場合は初期構造を返す
    const defaultData = { folders: [] };
    return new Response(data || JSON.stringify(defaultData), {
        headers: { "Content-Type": "application/json" }
    });
}

// データ保存 (POST /api/data)
export async function onRequestPost(context) {
    const { request, env } = context;
    const username = await authenticate(request, env);
    if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

    // 送られてきたJSONデータをそのまま文字列として受け取りKVへ保存
    const appData = await request.text();
    await env.QUIZ_DB.put(`data:${username}`, appData);

    return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
    });
}