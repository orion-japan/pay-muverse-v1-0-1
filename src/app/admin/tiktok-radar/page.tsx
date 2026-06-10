import Link from "next/link";
import {
  sofiaTikTokSupabase,
  type TikTokMarketResearch,
} from "@/lib/sofia/tiktok-radar/supabase";

type PageSearchParams = Record<string, string | string[] | undefined>;

function getParam(params: PageSearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
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
  } else {
    query = query.order("created_at", { ascending: false });
  }

  const { data, error } = await query.limit(100);
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
          options={["new", "why", "resonance", "save"]}
          labels={{
            new: "新しい順",
            why: "なんでスコア順",
            resonance: "共鳴スコア順",
            save: "保存意図順",
          }}
        />

        <button
          type="submit"
          style={{
            height: 42,
            padding: "0 16px",
            borderRadius: 10,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          絞り込み
        </button>

        <Link
          href="/admin/tiktok-radar"
          style={{
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
          }}
        >
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
            条件に合う登録データがありません。
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

const fieldStyle = {
  height: 42,
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
};