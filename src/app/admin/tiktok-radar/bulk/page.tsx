"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { sofiaTikTokSupabase } from "@/lib/sofia/tiktok-radar/supabase";

const LAST_BULK_STORAGE_KEY = "sofia_tiktok_radar_bulk_defaults";

const CATEGORY_OPTIONS = [
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
];

type BulkResult = {
  insertedCount: number;
  duplicateCount: number;
  invalidCount: number;
  inputDuplicateCount: number;
  insertedUrls: string[];
  duplicateUrls: string[];
  invalidUrls: string[];
  inputDuplicateUrls: string[];
};

const DEFAULT_RESULT: BulkResult = {
  insertedCount: 0,
  duplicateCount: 0,
  invalidCount: 0,
  inputDuplicateCount: 0,
  insertedUrls: [],
  duplicateUrls: [],
  invalidUrls: [],
  inputDuplicateUrls: [],
};

function normalizeVideoUrl(value: string) {
  return value.trim().split("?")[0].replace(/\/+$/, "");
}

function isValidTikTokUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.includes("tiktok.com");
  } catch {
    return false;
  }
}

function parseBulkUrls(rawText: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => normalizeVideoUrl(line))
    .filter(Boolean);

  const seen = new Set<string>();
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];
  const inputDuplicateUrls: string[] = [];

  for (const url of lines) {
    if (!isValidTikTokUrl(url)) {
      invalidUrls.push(url);
      continue;
    }

    if (seen.has(url)) {
      inputDuplicateUrls.push(url);
      continue;
    }

    seen.add(url);
    validUrls.push(url);
  }

  return {
    validUrls,
    invalidUrls,
    inputDuplicateUrls,
  };
}

export default function TikTokRadarBulkPage() {
  const [rawText, setRawText] = useState("");
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_BULK_STORAGE_KEY);

    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as {
        category?: string;
        keyword?: string;
      };

      setCategory(parsed.category ?? "");
      setKeyword(parsed.keyword ?? "");
    } catch {
      window.localStorage.removeItem(LAST_BULK_STORAGE_KEY);
    }
  }, []);

  const preview = useMemo(() => parseBulkUrls(rawText), [rawText]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setResult(null);

    const parsed = parseBulkUrls(rawText);

    if (parsed.validUrls.length === 0) {
      setResult({
        ...DEFAULT_RESULT,
        invalidCount: parsed.invalidUrls.length,
        inputDuplicateCount: parsed.inputDuplicateUrls.length,
        invalidUrls: parsed.invalidUrls,
        inputDuplicateUrls: parsed.inputDuplicateUrls,
      });
      setSaving(false);
      return;
    }

    const { data: existingItems, error: existingError } = await sofiaTikTokSupabase
      .from("tiktok_market_research")
      .select("video_url")
      .in("video_url", parsed.validUrls);

    if (existingError) {
      setError(existingError.message);
      setSaving(false);
      return;
    }

    const existingUrls = new Set(
      (existingItems ?? [])
        .map((item) => item.video_url)
        .filter((url): url is string => Boolean(url))
    );

    const duplicateUrls = parsed.validUrls.filter((url) => existingUrls.has(url));
    const insertUrls = parsed.validUrls.filter((url) => !existingUrls.has(url));

    if (insertUrls.length === 0) {
      setResult({
        insertedCount: 0,
        duplicateCount: duplicateUrls.length,
        invalidCount: parsed.invalidUrls.length,
        inputDuplicateCount: parsed.inputDuplicateUrls.length,
        insertedUrls: [],
        duplicateUrls,
        invalidUrls: parsed.invalidUrls,
        inputDuplicateUrls: parsed.inputDuplicateUrls,
      });
      setSaving(false);
      return;
    }

    const payload = insertUrls.map((videoUrl) => ({
      category: category || null,
      keyword: keyword || null,
      video_url: videoUrl,
      status: "draft",
      views_count: 0,
      likes_count: 0,
      comments_count: 0,
      shares_count: 0,
      saves_count: 0,
      followers_count: 0,
      why_known_score: 0,
      resonance_score: 0,
      save_intent_score: 0,
    }));

    const { error: insertError } = await sofiaTikTokSupabase
      .from("tiktok_market_research")
      .insert(payload);

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    window.localStorage.setItem(
      LAST_BULK_STORAGE_KEY,
      JSON.stringify({
        category,
        keyword,
      })
    );

    setResult({
      insertedCount: insertUrls.length,
      duplicateCount: duplicateUrls.length,
      invalidCount: parsed.invalidUrls.length,
      inputDuplicateCount: parsed.inputDuplicateUrls.length,
      insertedUrls: insertUrls,
      duplicateUrls,
      invalidUrls: parsed.invalidUrls,
      inputDuplicateUrls: parsed.inputDuplicateUrls,
    });

    setSaving(false);
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800 }}>TikTok URL一括登録</h1>
          <p style={{ color: "#555" }}>
            TikTok動画URLを複数貼り付けて、市場データの下書きとしてまとめて登録します。
          </p>
        </div>

        <Link
          href="/admin/tiktok-radar"
          style={{
            height: 44,
            padding: "10px 18px",
            borderRadius: 10,
            background: "#111",
            color: "#fff",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          一覧へ戻る
        </Link>
      </div>

      {error ? (
        <div style={{ marginTop: 16, color: "#b00020", fontWeight: 700 }}>
          登録エラー: {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} style={{ marginTop: 24 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginBottom: 16,
          }}
        >
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>一括カテゴリ</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={fieldStyle}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option || "empty"} value={option}>
                  {option || "未分類"}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>一括キーワード</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例：連絡が来ない / 復縁 / 自己否定"
              style={fieldStyle}
            />
          </label>
        </div>

        <label style={{ display: "grid", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>
            TikTok URL（1行に1URL）
          </span>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`https://www.tiktok.com/@aaa/video/1111111111\nhttps://www.tiktok.com/@bbb/video/2222222222\nhttps://www.tiktok.com/@ccc/video/3333333333`}
            rows={14}
            style={{
              ...fieldStyle,
              minHeight: 260,
              resize: "vertical",
              lineHeight: 1.6,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          />
        </label>

        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 12,
            background: "#f7f7f7",
            color: "#444",
            fontSize: 14,
            lineHeight: 1.8,
          }}
        >
          <div>登録候補: {preview.validUrls.length}件</div>
          <div>入力内の重複: {preview.inputDuplicateUrls.length}件</div>
          <div>不正URL: {preview.invalidUrls.length}件</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              height: 46,
              padding: "0 20px",
              borderRadius: 10,
              border: "none",
              background: saving ? "#777" : "#111",
              color: "#fff",
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "一括登録中..." : "一括登録する"}
          </button>

          <button
            type="button"
            onClick={() => {
              setRawText("");
              setResult(null);
              setError("");
            }}
            style={{
              height: 46,
              padding: "0 20px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              color: "#111",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            入力をクリア
          </button>
        </div>
      </form>

      {result ? (
        <section
          style={{
            marginTop: 28,
            padding: 18,
            borderRadius: 14,
            background: "#fff",
            border: "1px solid #e5e5e5",
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 800 }}>登録結果</h2>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
            }}
          >
            <ResultCard label="登録成功" value={result.insertedCount} />
            <ResultCard label="既存重複スキップ" value={result.duplicateCount} />
            <ResultCard label="入力内重複" value={result.inputDuplicateCount} />
            <ResultCard label="不正URL" value={result.invalidCount} />
          </div>

          <ResultList title="登録したURL" urls={result.insertedUrls} />
          <ResultList title="既存重複でスキップしたURL" urls={result.duplicateUrls} />
          <ResultList title="入力内重複でスキップしたURL" urls={result.inputDuplicateUrls} />
          <ResultList title="不正URL" urls={result.invalidUrls} />

          <div style={{ marginTop: 20 }}>
            <Link
              href="/admin/tiktok-radar"
              style={{
                height: 42,
                padding: "0 16px",
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
              一覧で確認する
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ResultCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        background: "#f7f7f7",
      }}
    >
      <div style={{ fontSize: 13, color: "#666", fontWeight: 700 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 26, fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function ResultList({ title, urls }: { title: string; urls: string[] }) {
  if (urls.length === 0) {
    return null;
  }

  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 800 }}>
        {title}（{urls.length}件）
      </summary>

      <ul
        style={{
          marginTop: 10,
          padding: 12,
          borderRadius: 10,
          background: "#fafafa",
          display: "grid",
          gap: 8,
          wordBreak: "break-all",
        }}
      >
        {urls.map((url) => (
          <li key={`${title}-${url}`} style={{ color: "#333" }}>
            {url}
          </li>
        ))}
      </ul>
    </details>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
  fontSize: 15,
};