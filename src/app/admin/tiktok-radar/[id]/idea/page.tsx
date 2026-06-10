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
      <main style={pageStyle}>
        <h1 style={titleStyle}>投稿案</h1>
        <p style={errorStyle}>データを読み込めませんでした。</p>
        <Link href="/admin/tiktok-radar" style={linkStyle}>
          一覧へ戻る
        </Link>
      </main>
    );
  }

  const idea = buildTikTokRadarPostIdea(data);

  return (
    <main style={pageStyle}>
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>投稿案</h1>
          <p style={subTextStyle}>市場データからTikTok投稿の入口を生成します。</p>
        </div>

        <Link href="/admin/tiktok-radar" style={linkStyle}>
          一覧へ戻る
        </Link>
      </div>

      <section style={summaryStyle}>
        <div>
          <div style={labelStyle}>カテゴリ</div>
          <div style={valueStyle}>{data.category || "-"}</div>
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

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>標準投稿案</h2>
        <IdeaBlock title="TikTok冒頭案" text={idea.opening} />
        <IdeaBlock title="本文案" text={idea.body} />
        <IdeaBlock title="Muへの導線" text={idea.muLead} />
        <IdeaBlock title="ハッシュタグ案" text={idea.hashtags} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>4パターン投稿案</h2>

        <div style={variantGridStyle}>
          {idea.variants.map((variant) => (
            <article key={variant.title} style={variantCardStyle}>
              <h3 style={variantTitleStyle}>{variant.title}</h3>
              <p style={variantDescriptionStyle}>{variant.description}</p>

              <IdeaBlock title="冒頭" text={variant.opening} compact />
              <IdeaBlock title="本文" text={variant.body} compact />
              <IdeaBlock title="Mu導線" text={variant.muLead} compact />
              <IdeaBlock title="ハッシュタグ" text={variant.hashtags} compact />
            </article>
          ))}
        </div>
      </section>

      <section style={{ ...sectionStyle, marginTop: 24 }}>
        <h2 style={sectionTitleStyle}>元データ</h2>
        <IdeaBlock title="元の冒頭フック" text={data.hook_text || "-"} compact />
        <IdeaBlock title="上位コメント" text={data.top_comment || "-"} compact />
        <IdeaBlock title="反応語" text={data.reaction_words || "-"} compact />
        <IdeaBlock title="共鳴語" text={data.resonance_words || "-"} compact />
        <IdeaBlock title="Sofiaメモ" text={data.sofia_note || "-"} compact />
      </section>
    </main>
  );
}

function IdeaBlock({
  title,
  text,
  compact = false,
}: {
  title: string;
  text: string;
  compact?: boolean;
}) {
  return (
    <div style={compact ? compactBlockStyle : blockStyle}>
      <div style={blockTitleStyle}>{title}</div>
      <pre style={preStyle}>{text}</pre>
    </div>
  );
}

const pageStyle: CSSProperties = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto",
  padding: "32px 24px 64px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 20,
  marginBottom: 24,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 32,
  fontWeight: 900,
};

const subTextStyle: CSSProperties = {
  marginTop: 8,
  color: "#666",
  fontSize: 14,
};

const linkStyle: CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  borderRadius: 12,
  background: "#111",
  color: "#fff",
  textDecoration: "none",
  fontWeight: 700,
};

const errorStyle: CSSProperties = {
  color: "#b00020",
  fontWeight: 700,
};

const summaryStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 16,
  padding: 20,
  borderRadius: 18,
  background: "#f6f4ef",
  marginBottom: 24,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: "#777",
  fontWeight: 700,
  marginBottom: 6,
};

const valueStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
};

const sectionStyle: CSSProperties = {
  padding: 20,
  borderRadius: 18,
  background: "#fff",
  border: "1px solid #e8e0d5",
  marginTop: 20,
};

const sectionTitleStyle: CSSProperties = {
  margin: "0 0 16px",
  fontSize: 22,
  fontWeight: 900,
};

const blockStyle: CSSProperties = {
  marginTop: 16,
  padding: 16,
  borderRadius: 14,
  background: "#faf8f3",
  border: "1px solid #eee4d7",
};

const compactBlockStyle: CSSProperties = {
  marginTop: 12,
  padding: 12,
  borderRadius: 12,
  background: "#faf8f3",
  border: "1px solid #eee4d7",
};

const blockTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#6f5533",
  marginBottom: 8,
};

const preStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
  fontSize: 15,
  lineHeight: 1.8,
  color: "#222",
};

const variantGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 18,
};

const variantCardStyle: CSSProperties = {
  padding: 18,
  borderRadius: 18,
  border: "1px solid #e8e0d5",
  background: "#fffdf8",
};

const variantTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 900,
};

const variantDescriptionStyle: CSSProperties = {
  margin: "6px 0 12px",
  color: "#777",
  fontSize: 13,
  fontWeight: 700,
};