import Link from "next/link";
import type { CSSProperties } from "react";
import {
  sofiaTikTokSupabase,
  type TikTokMarketResearch,
} from "@/lib/sofia/tiktok-radar/supabase";

type PageSearchParams = Record<string, string | string[] | undefined>;

type RadarWordRank = {
  word: string;
  count: number;
};

function getParam(params: PageSearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function scoreNumber(value: number | string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function totalScore(item: TikTokMarketResearch) {
  return (
    scoreNumber(item.why_known_score) +
    scoreNumber(item.resonance_score) +
    scoreNumber(item.save_intent_score)
  );
}

function muLeadScore(item: TikTokMarketResearch) {
  const text = [
    item.category,
    item.keyword,
    item.hook_text,
    item.caption_text,
    item.top_comment,
    item.reaction_words,
    item.resonance_words,
    item.sofia_note,
  ]
    .filter(Boolean)
    .join(" ");

  const base = totalScore(item);
  const hasMuAngle =
    text.includes("なんで") ||
    text.includes("見抜") ||
    text.includes("本当は") ||
    text.includes("相手の気持ち") ||
    text.includes("自己否定") ||
    text.includes("苦しい");
  const hasSaveIntent = text.includes("保存") || text.includes("見返す");

  return Math.min(20, base + (hasMuAngle ? 3 : 0) + (hasSaveIntent ? 2 : 0));
}

function engagementRate(item: TikTokMarketResearch) {
  const views = scoreNumber(item.views_count);
  if (views <= 0) return 0;

  return (
    ((scoreNumber(item.likes_count) +
      scoreNumber(item.comments_count) +
      scoreNumber(item.shares_count) +
      scoreNumber(item.saves_count)) /
      views) *
    100
  );
}

function formatPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function pickTopItems(items: TikTokMarketResearch[], count: number) {
  return [...items]
    .sort((a, b) => muLeadScore(b) - muLeadScore(a))
    .slice(0, count);
}

function countByStatus(items: TikTokMarketResearch[]) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const status = item.status || "draft";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

function splitRadarWords(value: string | null | undefined) {
  return (value ?? "")
    .split(/[\/\n,、。\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

function rankWords(items: TikTokMarketResearch[], key: "reaction_words" | "resonance_words") {
  const counts = new Map<string, number>();

  for (const item of items) {
    for (const word of splitRadarWords(item[key])) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 8);
}

function buildSofiaSummary(items: TikTokMarketResearch[]) {
  if (items.length === 0) {
    return "まだ市場データがありません。まずはTikTok URLを一括登録して、Sofiaが読める素材を増やしてください。";
  }

  const top = pickTopItems(items, 1)[0];
  const resonanceWords = rankWords(items, "resonance_words")
    .slice(0, 3)
    .map((item) => item.word)
    .join(" / ");
  const draftCount = items.filter((item) => (item.status || "draft") === "draft").length;

  return [
    top
      ? `今日の最優先素材は「${top.keyword || top.category || "未分類"}」です。Mu導線スコアが高く、投稿案化に向いています。`
      : "今日の最優先素材はまだありません。",
    resonanceWords
      ? `いま強い共鳴語は ${resonanceWords} です。`
      : "共鳴語はまだ十分に蓄積されていません。",
    draftCount > 0
      ? `未分析・下書き素材が ${draftCount} 件あります。まず上位候補だけ投稿案へ回すと効率的です。`
      : "下書き素材は整理されています。winner/good から投稿化を進められます。",
  ].join("\n");
}

function buildWorkFeed(items: TikTokMarketResearch[]) {
  const statusCounts = countByStatus(items);
  const topMuLead = pickTopItems(items, 3);
  const saveCandidates = [...items]
    .sort((a, b) => scoreNumber(b.save_intent_score) - scoreNumber(a.save_intent_score))
    .slice(0, 3);

  const feed = [
    `登録素材: ${items.length}件 / winner: ${statusCounts.winner ?? 0}件 / good: ${statusCounts.good ?? 0}件 / draft: ${statusCounts.draft ?? 0}件`,
    topMuLead.length > 0
      ? `Mu導線候補: ${topMuLead.map((item) => item.keyword || item.category || "未分類").join(" / ")}`
      : "Mu導線候補: まだありません",
    saveCandidates.length > 0
      ? `保存型に向く素材: ${saveCandidates.map((item) => item.keyword || item.category || "未分類").join(" / ")}`
      : "保存型に向く素材: まだありません",
  ];

  return feed;
}

export default async function TikTokRadarPage({
  searchParams,
}: {
  searchParams?: Promise<PageSearchParams>;
}) {
  const params = (await searchParams) ?? {};

  const category = getParam(params, "category");
  const status = getParam(params, "status");
  const keyword = getParam(params, "keyword");
  const sort = getParam(params, "sort") || "new";

  let query = sofiaTikTokSupabase
    .from("tiktok_market_research")
    .select("*");

  if (category) {
    query = query.eq("category", category);
  }

  if (status) {
    query = query.eq("status", status);
  }

  if (keyword) {
    query = query.or(
      `keyword.ilike.%${keyword}%,hook_text.ilike.%${keyword}%,reaction_words.ilike.%${keyword}%,resonance_words.ilike.%${keyword}%`
    );
  }

  if (sort === "why") {
    query = query.order("why_known_score", { ascending: false });
  } else if (sort === "resonance") {
    query = query.order("resonance_score", { ascending: false });
  } else if (sort === "save") {
    query = query.order("save_intent_score", { ascending: false });
  } else if (sort === "mu") {
    query = query.order("why_known_score", { ascending: false });
  } else {
    query = query.order("created_at", { ascending: false });
  }

  const [{ data, error }, { data: allData }] = await Promise.all([
    query.limit(100),
    sofiaTikTokSupabase
      .from("tiktok_market_research")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const items = (data ?? []) as TikTokMarketResearch[];
  const allItems = (allData ?? items) as TikTokMarketResearch[];
  const dashboardItems = allItems.length > 0 ? allItems : items;
  const statusCounts = countByStatus(dashboardItems);
  const topMuLeadItems = pickTopItems(dashboardItems, 3);
  const resonanceWords = rankWords(dashboardItems, "resonance_words");
  const reactionWords = rankWords(dashboardItems, "reaction_words");
  const sofiaSummary = buildSofiaSummary(dashboardItems);
  const workFeed = buildWorkFeed(dashboardItems);

  return (
    <main style={{ padding: 24, maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>
            Sofia TikTok市場レーダー
          </h1>
          <p style={{ marginTop: 8, color: "#666" }}>
            TikTok市場動画の冒頭フック、反応語、共鳴語を蓄積し、Muverse投稿導線へ変換します。
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link href="/admin/tiktok-radar/bulk" style={secondaryButtonStyle}>
            URL一括登録
          </Link>

          <Link href="/admin/tiktok-radar/new" style={primaryButtonStyle}>
            新規登録
          </Link>
        </div>
      </div>

      <section style={radarPanelStyle}>
        <div style={summaryHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>Sofia 今日のレーダー</div>
            <pre style={summaryTextStyle}>{sofiaSummary}</pre>
          </div>
          <div style={scoreCardStyle}>
            <div style={scoreCardLabelStyle}>Mu導線候補</div>
            <div style={scoreCardValueStyle}>{topMuLeadItems.length}件</div>
            <div style={scoreCardHintStyle}>高共鳴・保存・見抜き素材</div>
          </div>
        </div>

        <div style={metricGridStyle}>
          <MetricCard label="登録素材" value={`${dashboardItems.length}件`} hint="全市場データ" />
          <MetricCard label="winner" value={`${statusCounts.winner ?? 0}件`} hint="投稿化優先" />
          <MetricCard label="good" value={`${statusCounts.good ?? 0}件`} hint="調整して投稿化" />
          <MetricCard label="draft" value={`${statusCounts.draft ?? 0}件`} hint="未整理素材" />
        </div>

        <div style={insightGridStyle}>
          <InsightList title="Mu導線スコア上位" items={topMuLeadItems} />
          <WordList title="共鳴語ランキング" words={resonanceWords} />
          <WordList title="反応語ランキング" words={reactionWords} />
        </div>

        <div style={feedStyle}>
          <div style={feedTitleStyle}>Sofia Work Feed</div>
          {workFeed.map((message) => (
            <div key={message} style={feedItemStyle}>
              {message}
            </div>
          ))}
        </div>
      </section>

      <form
        action="/admin/tiktok-radar"
        style={{
          marginTop: 24,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1.2fr 1fr auto auto",
          gap: 12,
          alignItems: "end",
          padding: 16,
          borderRadius: 12,
          background: "#f7f7f7",
        }}
      >
        <Select
          label="カテゴリ"
          name="category"
          defaultValue={category}
          options={[
            "",
            "恋愛心理",
            "復縁",
            "片思い",
            "夫婦関係",
            "自己受容",
            "成功論",
            "スピリチュアル",
            "AI・Mu",
            "都市伝説",
            "その他",
          ]}
        />

        <Select
          label="状態"
          name="status"
          defaultValue={status}
          options={["", "draft", "watch", "good", "winner", "rejected"]}
        />

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>キーワード検索</span>
          <input
            name="keyword"
            defaultValue={keyword}
            placeholder="復縁 / なんで / 共鳴語など"
            style={fieldStyle}
          />
        </label>

        <Select
          label="並び順"
          name="sort"
          defaultValue={sort}
          options={["new", "why", "resonance", "save", "mu"]}
          labels={{
            new: "新しい順",
            why: "なんでスコア順",
            resonance: "共鳴スコア順",
            save: "保存意図順",
            mu: "Mu導線候補順",
          }}
        />

        <button type="submit" style={primarySubmitStyle}>
          絞り込み
        </button>

        <Link href="/admin/tiktok-radar" style={secondarySubmitStyle}>
          解除
        </Link>
      </form>

      <div style={{ marginTop: 14, color: "#666", fontSize: 13 }}>
        表示件数: {items.length}件
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

      <section style={{ marginTop: 18 }}>
        <div style={tableHeaderStyle}>
          <div>カテゴリ</div>
          <div>冒頭フック</div>
          <div>なんで</div>
          <div>共鳴</div>
          <div>保存</div>
          <div>Mu導線</div>
          <div>状態</div>
          <div>操作</div>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 24, color: "#666" }}>
            条件に合う登録データがありません。
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id} style={tableRowStyle}>
              <div>
                <div style={{ fontWeight: 700 }}>
                  {item.category || "未分類"}
                </div>
                <div style={{ marginTop: 4, color: "#666", fontSize: 12 }}>
                  {item.keyword || "-"}
                </div>
                <div style={{ marginTop: 6, color: "#888", fontSize: 12 }}>
                  反応率 {formatPercent(engagementRate(item))}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700 }}>
                  {item.hook_text || "冒頭フック未入力"}
                </div>
                <a href={item.video_url} target="_blank" rel="noreferrer" style={externalLinkStyle}>
                  TikTokを開く
                </a>
              </div>

              <ScorePill value={scoreNumber(item.why_known_score)} />
              <ScorePill value={scoreNumber(item.resonance_score)} />
              <ScorePill value={scoreNumber(item.save_intent_score)} />
              <ScorePill value={muLeadScore(item)} max={20} />
              <div>
                <StatusBadge status={item.status || "draft"} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link href={`/admin/tiktok-radar/${item.id}/idea`} style={ideaButtonStyle}>
                  投稿案
                </Link>

                <Link href={`/admin/tiktok-radar/${item.id}/edit`} style={editButtonStyle}>
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

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={metricCardStyle}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={metricValueStyle}>{value}</div>
      <div style={metricHintStyle}>{hint}</div>
    </div>
  );
}

function InsightList({ title, items }: { title: string; items: TikTokMarketResearch[] }) {
  return (
    <div style={insightCardStyle}>
      <h2 style={insightTitleStyle}>{title}</h2>
      {items.length === 0 ? (
        <p style={emptyInsightStyle}>候補がありません。</p>
      ) : (
        items.map((item, index) => (
          <Link key={item.id} href={`/admin/tiktok-radar/${item.id}/idea`} style={insightItemStyle}>
            <span style={rankStyle}>{index + 1}</span>
            <span>
              <strong>{item.keyword || item.category || "未分類"}</strong>
              <small style={insightSmallStyle}>Mu導線 {muLeadScore(item)} / 合計 {totalScore(item)}</small>
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

function WordList({ title, words }: { title: string; words: RadarWordRank[] }) {
  return (
    <div style={insightCardStyle}>
      <h2 style={insightTitleStyle}>{title}</h2>
      {words.length === 0 ? (
        <p style={emptyInsightStyle}>まだ十分な語がありません。</p>
      ) : (
        <div style={wordWrapStyle}>
          {words.map((item) => (
            <span key={item.word} style={wordBadgeStyle}>
              {item.word} <small>{item.count}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ScorePill({ value, max = 5 }: { value: number; max?: number }) {
  const ratio = max > 0 ? value / max : 0;
  const background = ratio >= 0.75 ? "#e9f8ef" : ratio >= 0.45 ? "#fff6dd" : "#f4f4f4";
  const color = ratio >= 0.75 ? "#0f7a3b" : ratio >= 0.45 ? "#8a5c00" : "#555";

  return (
    <div style={{ ...scorePillStyle, background, color }}>
      {value}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const background =
    status === "winner"
      ? "#e9f8ef"
      : status === "good"
        ? "#edf4ff"
        : status === "rejected"
          ? "#fff0f0"
          : "#f5f5f5";
  const color =
    status === "winner"
      ? "#0f7a3b"
      : status === "good"
        ? "#2459a6"
        : status === "rejected"
          ? "#b00020"
          : "#555";

  return <span style={{ ...statusBadgeStyle, background, color }}>{status}</span>;
}

function Select({
  label,
  name,
  defaultValue,
  options,
  labels = {},
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <select name={name} defaultValue={defaultValue} style={fieldStyle}>
        {options.map((option) => (
          <option key={option} value={option}>
            {(labels[option] ?? option) || "すべて"}
          </option>
        ))}
      </select>
    </label>
  );
}

const fieldStyle: CSSProperties = {
  height: 42,
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
};

const primaryButtonStyle: CSSProperties = {
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
};

const secondaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  background: "#fff",
  color: "#111",
  border: "1px solid #ddd",
};

const primarySubmitStyle: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 10,
  border: "none",
  background: "#111",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};

const secondarySubmitStyle: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
  color: "#111",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
};

const radarPanelStyle: CSSProperties = {
  marginTop: 24,
  padding: 20,
  borderRadius: 20,
  background: "#fffdf8",
  border: "1px solid #eadfce",
};

const summaryHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 220px",
  gap: 18,
  alignItems: "stretch",
};

const eyebrowStyle: CSSProperties = {
  fontSize: 13,
  color: "#7a5a2c",
  fontWeight: 900,
  letterSpacing: "0.04em",
};

const summaryTextStyle: CSSProperties = {
  margin: "10px 0 0",
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  lineHeight: 1.8,
  color: "#222",
};

const scoreCardStyle: CSSProperties = {
  padding: 18,
  borderRadius: 16,
  background: "#111",
  color: "#fff",
};

const scoreCardLabelStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.78,
  fontWeight: 700,
};

const scoreCardValueStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 36,
  fontWeight: 900,
};

const scoreCardHintStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  opacity: 0.75,
};

const metricGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 12,
  marginTop: 18,
};

const metricCardStyle: CSSProperties = {
  padding: 14,
  borderRadius: 14,
  background: "#faf8f3",
  border: "1px solid #eee4d7",
};

const metricLabelStyle: CSSProperties = {
  color: "#777",
  fontSize: 12,
  fontWeight: 800,
};

const metricValueStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 24,
  fontWeight: 900,
};

const metricHintStyle: CSSProperties = {
  marginTop: 4,
  color: "#777",
  fontSize: 12,
};

const insightGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.2fr 1fr 1fr",
  gap: 14,
  marginTop: 16,
};

const insightCardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 16,
  background: "#fff",
  border: "1px solid #eee4d7",
};

const insightTitleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 16,
  fontWeight: 900,
};

const insightItemStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "10px 0",
  color: "#111",
  textDecoration: "none",
  borderTop: "1px solid #f0ede7",
};

const rankStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  background: "#111",
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 900,
  flex: "0 0 auto",
};

const insightSmallStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  color: "#777",
  fontSize: 12,
};

const emptyInsightStyle: CSSProperties = {
  margin: 0,
  color: "#777",
  fontSize: 13,
};

const wordWrapStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const wordBadgeStyle: CSSProperties = {
  display: "inline-flex",
  gap: 6,
  alignItems: "center",
  padding: "7px 10px",
  borderRadius: 999,
  background: "#f6f4ef",
  color: "#342719",
  fontSize: 12,
  fontWeight: 800,
};

const feedStyle: CSSProperties = {
  marginTop: 16,
  padding: 14,
  borderRadius: 16,
  background: "#f6f4ef",
};

const feedTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#6f5533",
  marginBottom: 8,
};

const feedItemStyle: CSSProperties = {
  padding: "8px 0",
  borderTop: "1px solid #e8dfd1",
  fontSize: 13,
  color: "#333",
};

const tableHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1.45fr 0.5fr 0.5fr 0.5fr 0.65fr 0.65fr 1fr",
  gap: 12,
  padding: "12px 14px",
  borderRadius: 10,
  background: "#f4f4f4",
  fontWeight: 700,
  fontSize: 13,
};

const tableRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1.45fr 0.5fr 0.5fr 0.5fr 0.65fr 0.65fr 1fr",
  gap: 12,
  padding: "14px",
  borderBottom: "1px solid #eee",
  alignItems: "start",
  fontSize: 14,
};

const externalLinkStyle: CSSProperties = {
  display: "inline-block",
  marginTop: 6,
  color: "#2563eb",
  fontSize: 12,
};

const scorePillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 34,
  height: 30,
  padding: "0 8px",
  borderRadius: 999,
  fontWeight: 900,
};

const statusBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 28,
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 900,
};

const ideaButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 34,
  padding: "6px 12px",
  borderRadius: 8,
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  fontSize: 12,
  fontWeight: 700,
};

const editButtonStyle: CSSProperties = {
  ...ideaButtonStyle,
  background: "#111",
};
