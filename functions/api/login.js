export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        // フロントエンドから送られたID/PASSを取得
        const { username, password } = await request.json();
        
        // KVからユーザー情報を取得
        const userDataStr = await env.QUIZ_DB.get(`user:${username}`);
        if (!userDataStr) {
            return new Response(JSON.stringify({ error: "ユーザーが見つかりません" }), { status: 401 });
        }

        const userData = JSON.parse(userDataStr);
        if (userData.password !== password) {
            return new Response(JSON.stringify({ error: "パスワードが一致しません" }), { status: 401 });
        }

        // ランダムなトークンを生成し、KVに保存（有効期限: 24時間 = 86400秒）
        const token = crypto.randomUUID();
        await env.QUIZ_DB.put(`session:${token}`, username, { expirationTtl: 864000 });

        return new Response(JSON.stringify({ success: true, token, username }), {
            headers: { "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: "サーバーエラー" }), { status: 500 });
    }
}
