import Link from "next/link";
import {
  sofiaTikTokSupabase,
  type TikTokMarketResearch,
} from "@/lib/sofia/tiktok-radar/supabase";

export default async function TikTokRadarPage() {
  const { data, error } = await sofiaTikTokSupabase
    .from("tiktok_market_research")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const items = (data ?? []) as TikTokMarketResearch[];

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>
            Sofia TikTok市場レーダー
          </h1>
          <p style={{ marginTop: 8, color: "#666" }}>
            TikTok市場動画の冒頭フック、反応語、共鳴語を蓄積します。
          </p>
        </div>

        <Link
          href="/admin/tiktok-radar/new"
          style={{
            height: 44,
            padding: "0 18px",
            borderRadius: 10,
            background: "#111",
            color: "#fff",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
          }}
        >
          新規登録
        </Link>
      </div>

      {error ? (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 10,
            background: "#fff0f0",
            color: "#b00020",
          }}
        >
          読み込みエラー: {error.message}
        </div>
      ) : null}

      <section style={{ marginTop: 24 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.1fr 1.6fr 0.6fr 0.6fr 0.6fr 0.7fr 0.7fr",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 10,
            background: "#f4f4f4",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          <div>カテゴリ</div>
          <div>冒頭フック</div>
          <div>なんで</div>
          <div>共鳴</div>
          <div>保存</div>
          <div>状態</div>
          <div>操作</div>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 24, color: "#666" }}>
            まだ登録データがありません。
          </div>
        ) : (
          items.map((item) => (
            <article
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.1fr 1.6fr 0.6fr 0.6fr 0.6fr 0.7fr 0.7fr",
                gap: 12,
                padding: "14px",
                borderBottom: "1px solid #eee",
                alignItems: "start",
                fontSize: 14,
              }}
            >
              <div>
                <div style={{ fontWeight: 700 }}>
                  {item.category || "未分類"}
                </div>
                <div style={{ marginTop: 4, color: "#666", fontSize: 12 }}>
                  {item.keyword || "-"}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700 }}>
                  {item.hook_text || "冒頭フック未入力"}
                </div>
                <a
                  href={item.video_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    marginTop: 6,
                    color: "#2563eb",
                    fontSize: 12,
                  }}
                >
                  TikTokを開く
                </a>
              </div>

              <div>{item.why_known_score ?? 0}</div>
              <div>{item.resonance_score ?? 0}</div>
              <div>{item.save_intent_score ?? 0}</div>
              <div>{item.status || "draft"}</div>
              <div>
                <Link
                  href={`/admin/tiktok-radar/${item.id}/edit`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 34,
                    padding: "6px 12px",
                    borderRadius: 8,
                    background: "#111",
                    color: "#fff",
                    textDecoration: "none",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  編集
                </Link>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

