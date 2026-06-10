import Link from "next/link";
import type { CSSProperties } from "react";
import { sofiaTikTokSupabase } from "@/lib/sofia/tiktok-radar/supabase";
import { buildTikTokRadarPostIdea } from "@/lib/sofia/tiktok-radar/postIdea";

export default async function TikTokRadarIdeaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const { data, error } = await sofiaTikTokSupabase
    .from("tiktok_market_research")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return (
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>投稿案</h1>
        <p style={{ color: "#b00020", marginTop: 16 }}>
          データを読み込めませんでした。
        </p>
        <Link href="/admin/tiktok-radar" style={linkStyle}>
          一覧へ戻る
        </Link>
      </main>
    );
  }

  const idea = buildTikTokRadarPostIdea(data);

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800 }}>
            TikTok投稿案
          </h1>
          <p style={{ color: "#555", marginTop: 8 }}>
            市場レーダーの登録データから、投稿に使う文章案を作成します。
          </p>
        </div>

        <Link href="/admin/tiktok-radar" style={linkStyle}>
          一覧へ戻る
        </Link>
      </div>

      <section style={summaryStyle}>
        <div>
          <div style={labelStyle}>カテゴリ</div>
          <div style={valueStyle}>{data.category || "未分類"}</div>
        </div>
        <div>
          <div style={labelStyle}>キーワード</div>
          <div style={valueStyle}>{data.keyword || "-"}</div>
        </div>
        <div>
          <div style={labelStyle}>合計スコア</div>
          <div style={valueStyle}>
            {idea.totalScore}点 / {idea.scoreLabel}
          </div>
        </div>
      </section>

      <IdeaBlock title="TikTok冒頭案" text={idea.opening} />
      <IdeaBlock title="本文案" text={idea.body} />
      <IdeaBlock title="Muへの導線" text={idea.muLead} />
      <IdeaBlock title="ハッシュタグ案" text={idea.hashtags} />

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800 }}>元データ</h2>
        <div style={sourceBoxStyle}>
          <p><strong>冒頭フック：</strong>{data.hook_text || "-"}</p>
          <p><strong>反応語：</strong>{data.reaction_words || "-"}</p>
          <p><strong>共鳴語：</strong>{data.resonance_words || "-"}</p>
          <p><strong>Sofiaメモ：</strong></p>
          <pre style={preStyle}>{data.sofia_note || "-"}</pre>
        </div>
      </section>
    </main>
  );
}

function IdeaBlock({ title, text }: { title: string; text: string }) {
  return (
    <section style={blockStyle}>
      <h2 style={{ fontSize: 18, fontWeight: 800 }}>{title}</h2>
      <pre style={preStyle}>{text}</pre>
    </section>
  );
}

const linkStyle = {
  height: 44,
  padding: "10px 18px",
  borderRadius: 10,
  background: "#111",
  color: "#fff",
  textDecoration: "none",
  fontWeight: 700,
};

const summaryStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 12,
  marginTop: 24,
  padding: 16,
  borderRadius: 12,
  background: "#f7f7f7",
};

const labelStyle = {
  fontSize: 12,
  color: "#666",
  fontWeight: 700,
};

const valueStyle = {
  marginTop: 4,
  fontSize: 16,
  fontWeight: 800,
};

const blockStyle = {
  marginTop: 24,
  padding: 18,
  borderRadius: 12,
  border: "1px solid #eee",
  background: "#fff",
};

const sourceBoxStyle = {
  marginTop: 12,
  padding: 16,
  borderRadius: 12,
  background: "#fafafa",
  border: "1px solid #eee",
};

const preStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
  lineHeight: 1.8,
  marginTop: 10,
};