"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sofiaTikTokSupabase } from "@/lib/sofia/tiktok-radar/supabase";
import { analyzeTikTokRadarInput } from "@/lib/sofia/tiktok-radar/analyzer";

const LAST_FORM_STORAGE_KEY = "sofia_tiktok_radar_last_form";

const DEFAULT_FORM = {
  category: "",
  keyword: "",
  account_name: "",
  account_url: "",
  video_url: "",
  video_title: "",
  hook_text: "",
  caption_text: "",
  views_count: "0",
  likes_count: "0",
  comments_count: "0",
  shares_count: "0",
  saves_count: "0",
  followers_count: "0",
  top_comment: "",
  reaction_words: "",
  resonance_words: "",
  why_known_score: "0",
  resonance_score: "0",
  save_intent_score: "0",
  sofia_note: "",
  status: "draft",
};

type FormState = typeof DEFAULT_FORM;

export default function NewTikTokRadarPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_FORM_STORAGE_KEY);

    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as Partial<FormState>;

      setForm((prev) => ({
        ...prev,
        category: parsed.category ?? prev.category,
        keyword: parsed.keyword ?? prev.keyword,
        account_name: parsed.account_name ?? prev.account_name,
        account_url: parsed.account_url ?? prev.account_url,
        why_known_score: parsed.why_known_score ?? prev.why_known_score,
        resonance_score: parsed.resonance_score ?? prev.resonance_score,
        save_intent_score: parsed.save_intent_score ?? prev.save_intent_score,
        status: parsed.status ?? prev.status,
      }));
    } catch {
      window.localStorage.removeItem(LAST_FORM_STORAGE_KEY);
    }
  }, []);

  function updateField(name: string, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toNumber(value: string) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function handleAnalyze() {
    const result = analyzeTikTokRadarInput({
      category: form.category,
      keyword: form.keyword,
      hook_text: form.hook_text,
      caption_text: form.caption_text,
      top_comment: form.top_comment,
    });

    setForm((prev) => ({
      ...prev,
      reaction_words: result.reaction_words,
      resonance_words: result.resonance_words,
      why_known_score: result.why_known_score,
      resonance_score: result.resonance_score,
      save_intent_score: result.save_intent_score,
      sofia_note: result.sofia_note,
      status: result.status,
    }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const payload = {
      category: form.category || null,
      keyword: form.keyword || null,
      account_name: form.account_name || null,
      account_url: form.account_url || null,
      video_url: form.video_url,
      video_title: form.video_title || null,
      hook_text: form.hook_text || null,
      caption_text: form.caption_text || null,
      views_count: toNumber(form.views_count),
      likes_count: toNumber(form.likes_count),
      comments_count: toNumber(form.comments_count),
      shares_count: toNumber(form.shares_count),
      saves_count: toNumber(form.saves_count),
      followers_count: toNumber(form.followers_count),
      top_comment: form.top_comment || null,
      reaction_words: form.reaction_words || null,
      resonance_words: form.resonance_words || null,
      why_known_score: toNumber(form.why_known_score),
      resonance_score: toNumber(form.resonance_score),
      save_intent_score: toNumber(form.save_intent_score),
      sofia_note: form.sofia_note || null,
      status: form.status || "draft",
    };

    const { error: insertError } = await sofiaTikTokSupabase
      .from("tiktok_market_research")
      .insert(payload);

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    window.localStorage.setItem(
      LAST_FORM_STORAGE_KEY,
      JSON.stringify({
        category: form.category,
        keyword: form.keyword,
        account_name: form.account_name,
        account_url: form.account_url,
        why_known_score: form.why_known_score,
        resonance_score: form.resonance_score,
        save_intent_score: form.save_intent_score,
        status: form.status,
      })
    );

    router.push("/admin/tiktok-radar");
    router.refresh();
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800 }}>TikTok市場データ 新規登録</h1>
          <p style={{ color: "#555" }}>
            冒頭フック、反応語、共鳴語、数値を登録します。
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
          保存エラー: {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} style={{ marginTop: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Select
            label="カテゴリ"
            value={form.category}
            onChange={(v) => updateField("category", v)}
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
          <Input label="キーワード" value={form.keyword} onChange={(v) => updateField("keyword", v)} />
          <Input label="アカウント名" value={form.account_name} onChange={(v) => updateField("account_name", v)} />
          <Input label="アカウントURL" value={form.account_url} onChange={(v) => updateField("account_url", v)} />
          <Input label="動画URL（必須）" value={form.video_url} onChange={(v) => updateField("video_url", v)} required />
          <Input label="動画タイトル" value={form.video_title} onChange={(v) => updateField("video_title", v)} />
        </div>

        <Textarea label="冒頭フック" value={form.hook_text} onChange={(v) => updateField("hook_text", v)} />
        <Textarea label="キャプション" value={form.caption_text} onChange={(v) => updateField("caption_text", v)} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginTop: 16 }}>
          <Input label="再生" value={form.views_count} onChange={(v) => updateField("views_count", v)} type="number" />
          <Input label="いいね" value={form.likes_count} onChange={(v) => updateField("likes_count", v)} type="number" />
          <Input label="コメント" value={form.comments_count} onChange={(v) => updateField("comments_count", v)} type="number" />
          <Input label="シェア" value={form.shares_count} onChange={(v) => updateField("shares_count", v)} type="number" />
          <Input label="保存" value={form.saves_count} onChange={(v) => updateField("saves_count", v)} type="number" />
          <Input label="フォロワー" value={form.followers_count} onChange={(v) => updateField("followers_count", v)} type="number" />
        </div>

        <Textarea label="上位コメント" value={form.top_comment} onChange={(v) => updateField("top_comment", v)} />
        <Textarea label="反応語" value={form.reaction_words} onChange={(v) => updateField("reaction_words", v)} />
        <Textarea label="共鳴語" value={form.resonance_words} onChange={(v) => updateField("resonance_words", v)} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16 }}>
          <Select
            label="なんでスコア 0〜5"
            value={form.why_known_score}
            onChange={(v) => updateField("why_known_score", v)}
            options={["0", "1", "2", "3", "4", "5"]}
          />
          <Select
            label="共鳴スコア 0〜5"
            value={form.resonance_score}
            onChange={(v) => updateField("resonance_score", v)}
            options={["0", "1", "2", "3", "4", "5"]}
          />
          <Select
            label="保存意図 0〜5"
            value={form.save_intent_score}
            onChange={(v) => updateField("save_intent_score", v)}
            options={["0", "1", "2", "3", "4", "5"]}
          />
          <Select
            label="状態"
            value={form.status}
            onChange={(v) => updateField("status", v)}
            options={["draft", "watch", "good", "winner", "rejected"]}
          />
        </div>

        <Textarea label="Sofiaメモ" value={form.sofia_note} onChange={(v) => updateField("sofia_note", v)} />

        <button
          type="button"
          onClick={handleAnalyze}
          style={{
            marginTop: 24,
            marginRight: 12,
            padding: "14px 24px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#fff",
            color: "#111",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Sofia自動分析
        </button>

        <button
          type="submit"
          disabled={saving || !form.video_url}
          style={{
            marginTop: 24,
            padding: "14px 24px",
            borderRadius: 12,
            border: "none",
            background: saving || !form.video_url ? "#999" : "#111",
            color: "#fff",
            fontWeight: 800,
            cursor: saving || !form.video_url ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "保存中..." : "保存する"}
        </button>
      </form>
    </main>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#fff",
        }}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#fff",
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option || "未選択"}
          </option>
        ))}
      </select>
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6, marginTop: 16 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#fff",
          resize: "vertical",
        }}
      />
    </label>
  );
}

