"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { sofiaTikTokSupabase } from "@/lib/sofia/tiktok-radar/supabase";

const emptyForm = {
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

type FormState = typeof emptyForm;

export default function EditTikTokRadarPage() {
  const router = useRouter();
  const params = useParams();
  const id = typeof params?.id === "string" ? params.id : "";

  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadItem() {
      if (!id) return;

      const { data, error: fetchError } = await sofiaTikTokSupabase
        .from("tiktok_market_research")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError) {
        setError(fetchError.message);
        setLoading(false);
        return;
      }

      setForm({
        category: data.category ?? "",
        keyword: data.keyword ?? "",
        account_name: data.account_name ?? "",
        account_url: data.account_url ?? "",
        video_url: data.video_url ?? "",
        video_title: data.video_title ?? "",
        hook_text: data.hook_text ?? "",
        caption_text: data.caption_text ?? "",
        views_count: String(data.views_count ?? 0),
        likes_count: String(data.likes_count ?? 0),
        comments_count: String(data.comments_count ?? 0),
        shares_count: String(data.shares_count ?? 0),
        saves_count: String(data.saves_count ?? 0),
        followers_count: String(data.followers_count ?? 0),
        top_comment: data.top_comment ?? "",
        reaction_words: data.reaction_words ?? "",
        resonance_words: data.resonance_words ?? "",
        why_known_score: String(data.why_known_score ?? 0),
        resonance_score: String(data.resonance_score ?? 0),
        save_intent_score: String(data.save_intent_score ?? 0),
        sofia_note: data.sofia_note ?? "",
        status: data.status ?? "draft",
      });

      setLoading(false);
    }

    loadItem();
  }, [id]);

  function updateField(name: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toNumber(value: string) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!id) return;

    setSaving(true);
    setError("");

    const { error: updateError } = await sofiaTikTokSupabase
      .from("tiktok_market_research")
      .update({
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
      })
      .eq("id", id);

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    router.push("/admin/tiktok-radar");
    router.refresh();
  }

  if (loading) {
    return <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>読み込み中...</main>;
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800 }}>TikTok市場データ 編集</h1>
          <p style={{ color: "#555" }}>登録済みの市場データを修正します。</p>
        </div>

        <Link href="/admin/tiktok-radar" style={buttonLinkStyle}>
          一覧へ戻る
        </Link>
      </div>

      {error ? <div style={{ marginTop: 16, color: "#b00020", fontWeight: 700 }}>エラー: {error}</div> : null}

      <form onSubmit={handleSubmit} style={{ marginTop: 24 }}>
        <div style={twoColumnStyle}>
          <Select label="カテゴリ" value={form.category} onChange={(v) => updateField("category", v)} options={["", "恋愛心理", "復縁", "片思い", "夫婦関係", "自己受容", "成功論", "スピリチュアル", "AI・Mu", "都市伝説", "その他"]} />
          <Input label="キーワード" value={form.keyword} onChange={(v) => updateField("keyword", v)} />
          <Input label="アカウント名" value={form.account_name} onChange={(v) => updateField("account_name", v)} />
          <Input label="アカウントURL" value={form.account_url} onChange={(v) => updateField("account_url", v)} />
          <Input label="動画URL（必須）" value={form.video_url} onChange={(v) => updateField("video_url", v)} required />
          <Input label="動画タイトル" value={form.video_title} onChange={(v) => updateField("video_title", v)} />
        </div>

        <Textarea label="冒頭フック" value={form.hook_text} onChange={(v) => updateField("hook_text", v)} />
        <Textarea label="キャプション" value={form.caption_text} onChange={(v) => updateField("caption_text", v)} />

        <div style={sixColumnStyle}>
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

        <div style={fourColumnStyle}>
          <Select label="なんでスコア 0〜5" value={form.why_known_score} onChange={(v) => updateField("why_known_score", v)} options={["0", "1", "2", "3", "4", "5"]} />
          <Select label="共鳴スコア 0〜5" value={form.resonance_score} onChange={(v) => updateField("resonance_score", v)} options={["0", "1", "2", "3", "4", "5"]} />
          <Select label="保存意図 0〜5" value={form.save_intent_score} onChange={(v) => updateField("save_intent_score", v)} options={["0", "1", "2", "3", "4", "5"]} />
          <Select label="状態" value={form.status} onChange={(v) => updateField("status", v)} options={["draft", "watch", "good", "winner", "rejected"]} />
        </div>

        <Textarea label="Sofiaメモ" value={form.sofia_note} onChange={(v) => updateField("sofia_note", v)} />

        <button type="submit" disabled={saving || !form.video_url} style={submitStyle}>
          {saving ? "保存中..." : "更新する"}
        </button>
      </form>
    </main>
  );
}

const twoColumnStyle = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 };
const sixColumnStyle = { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginTop: 16 };
const fourColumnStyle = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16 };

const buttonLinkStyle = {
  height: 44,
  padding: "10px 18px",
  borderRadius: 10,
  background: "#111",
  color: "#fff",
  textDecoration: "none",
  fontWeight: 700,
};

const submitStyle = {
  marginTop: 24,
  padding: "14px 24px",
  borderRadius: 12,
  border: "none",
  background: "#111",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
};

function Input({ label, value, onChange, type = "text", required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <input type={type} required={required} value={value} onChange={(e) => onChange(e.target.value)} style={fieldStyle} />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={fieldStyle}>
        {options.map((option) => (
          <option key={option} value={option}>{option || "未選択"}</option>
        ))}
      </select>
    </label>
  );
}

function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 6, marginTop: 16 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} style={{ ...fieldStyle, resize: "vertical" }} />
    </label>
  );
}

const fieldStyle = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
};