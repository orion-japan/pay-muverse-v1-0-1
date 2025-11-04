// src/lib/notify.ts
export async function notifyReply(params: {
  targetUserCode: string; // 親投稿者（通知を受け取る人）
  postId: string; // 親スレのID (threadId)
  commentId: string; // 今回挿入されたコメントの post_id
  preview: string; // 本文プレビュー
}) {
  const { targetUserCode, postId, commentId, preview } = params;

  const base = process.env.HOME_URL || ''; // 例: https://muverse.jp
  const url = `${base}/thread/${encodeURIComponent(postId)}?focus=${encodeURIComponent(commentId)}`;

  // 既存の送信APIに橋渡し
  const res = await fetch(`${base}/api/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_code: targetUserCode,
      kind: 'rtalk', // consents.allow_r_talk 判定を有効に
      title: 'あなたのSelfTalkに返信がありました',
      body: preview.slice(0, 80),
      url,
      tag: `reply-${postId}`, // 同一スレは上書き
      renotify: true, // 上書きでも鳴らす
      // icon/badge は /api/push/send 側でデフォルト付与済み
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.warn('[notifyReply] push/send failed:', txt);
  }
}
