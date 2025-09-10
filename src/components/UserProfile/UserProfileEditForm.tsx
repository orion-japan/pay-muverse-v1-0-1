// src/components/UserProfile/UserProfileEditForm.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import './ProfileBox.css';

type MyData = {
  // users 側
  user_code: string;
  name: string;           // = users.click_username と同期
  click_email?: string | null;
  headline?: string | null;
  mission?: string | null;
  looking_for?: string | null;
  position?: string | null;
  organization?: string | null;
  Rcode?: string | null;
  REcode?: string | null;

  // profiles 側
  avatar_url?: string | null;
  bio?: string | null;
  prefecture?: string | null;
  city?: string | null;
  x_handle?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  website_url?: string | null;
  interests?: string[] | null;
  skills?: string[] | null;
  activity_area?: string[] | null;
  languages?: string[] | null;
  visibility?: string | null;
};

function toCsv(v?: string[] | null) {
  return Array.isArray(v) ? v.join(', ') : '';
}
function toArr(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function UserProfileEditForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [data, setData] = useState<MyData | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const idToken = await (await import('../.././lib/getIdToken')).default();
        const r = await fetch('/api/mypage/me', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const j = await r.json();
        if (j?.me) {
          const me = j.me as MyData;
          // name は v_mypage_user.name(=click_username)想定
          setData({
            ...me,
            name: me?.name || '',
          });
        } else {
          setMsg('プロフィールが取得できませんでした');
        }
      } catch (e: any) {
        setMsg(e?.message || '読み込みエラー');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setMsg(null);
    try {
      const idToken = await (await import('../../lib/getIdToken')).default();
      const payload = {
        // users 側
        click_email: data.click_email ?? '',
        click_username: data.name ?? '',
        headline: data.headline ?? '',
        mission: data.mission ?? '',
        looking_for: data.looking_for ?? '',
        position: data.position ?? '',
        organization: data.organization ?? '',
        // profiles 側
        bio: data.bio ?? '',
        prefecture: data.prefecture ?? '',
        city: data.city ?? '',
        x_handle: data.x_handle ?? '',
        instagram: data.instagram ?? '',
        facebook: data.facebook ?? '',
        linkedin: data.linkedin ?? '',
        youtube: data.youtube ?? '',
        website_url: data.website_url ?? '',
        interests: toArr(toCsv(data.interests || [])), // 正規化
        skills: toArr(toCsv(data.skills || [])),
        activity_area: toArr(toCsv(data.activity_area || [])),
        languages: toArr(toCsv(data.languages || [])),
        visibility: data.visibility ?? 'public',
        avatar_url: data.avatar_url ?? '',
      };
      const r = await fetch('/api/mypage/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '保存に失敗しました');
      setMsg('保存しました ✅');
    } catch (e: any) {
      setMsg(e?.message || '保存エラー');
    } finally {
      setSaving(false);
    }
  }

  function field<K extends keyof MyData>(k: K) {
    return {
      value: (data?.[k] as any) ?? '',
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setData((d) => ({ ...(d as any), [k]: e.target.value })),
    };
  }

  if (loading) return <div className="profile-box"><p>読み込み中…</p></div>;

  if (!data) return <div className="profile-box error"><p>{msg || 'データなし'}</p></div>;

  return (
    <div className="edit-wrapper">
      <div className="edit-header">
        <h1>マイページ編集</h1>
        <button className="mu-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '💾 保存する'}
        </button>
      </div>

      {msg && <div className="mu-toast">{msg}</div>}

      <section className="mu-card">
        <h2>基本</h2>
        <div className="grid-2">
          <label>
            ニックネーム（必須）
            <input type="text" maxLength={40} {...field('name')} placeholder="例：taro" />
          </label>
          <label>
            ひとこと肩書き（headline）
            <input type="text" maxLength={80} {...field('headline')} placeholder="例：しあわせ伝道師" />
          </label>
          <label>
            所属（organization）
            <input type="text" {...field('organization')} placeholder="例：Muverse Inc." />
          </label>
          <label>
            専門・役割（position）
            <input type="text" {...field('position')} placeholder="例：Product / Engineer" />
          </label>
          <label>
            県・市区町村
            <div className="grid-2 inner">
              <input type="text" {...field('prefecture')} placeholder="例：東京都" />
              <input type="text" {...field('city')} placeholder="例：港区" />
            </div>
          </label>
          <label>
            連絡メール（click_email）
            <input type="email" {...field('click_email')} placeholder="通知・連絡に使用" />
          </label>
        </div>
        <label>
          自己紹介（bio）
          <textarea rows={5} {...field('bio')} placeholder="あなたの意図や活動など。" />
        </label>
        <div className="grid-2">
          <label>
            意図・何をしているか（mission）
            <textarea rows={3} {...field('mission')} placeholder="短文でOK" />
          </label>
          <label>
            募集中・求めていること（looking_for）
            <textarea rows={3} {...field('looking_for')} placeholder="例：仲間募集 / 共同研究 など" />
          </label>
        </div>
      </section>

      <section className="mu-card">
        <h2>SNS / リンク</h2>
        <div className="grid-3">
          <label>X
            <input type="text" {...field('x_handle')} placeholder="@your_handle" />
          </label>
          <label>Instagram
            <input type="text" {...field('instagram')} placeholder="@your_ig" />
          </label>
          <label>Facebook
            <input type="text" {...field('facebook')} placeholder="facebook.com/..." />
          </label>
          <label>LinkedIn
            <input type="text" {...field('linkedin')} placeholder="linkedin.com/in/..." />
          </label>
          <label>YouTube
            <input type="text" {...field('youtube')} placeholder="youtube.com/@..." />
          </label>
          <label>Website
            <input type="url" {...field('website_url')} placeholder="https://..." />
          </label>
        </div>
      </section>

      <section className="mu-card">
        <h2>スキル / 興味 / 言語</h2>
        <div className="grid-3">
          <label>skills（カンマ区切り）
            <input
              type="text"
              value={toCsv(data.skills || [])}
              onChange={(e) => setData((d) => ({ ...(d as any), skills: toArr(e.target.value) }))}
              placeholder="design, nextjs, supabase"
            />
          </label>
          <label>interests（カンマ区切り）
            <input
              type="text"
              value={toCsv(data.interests || [])}
              onChange={(e) => setData((d) => ({ ...(d as any), interests: toArr(e.target.value) }))}
              placeholder="ai, resonance, art"
            />
          </label>
          <label>languages（カンマ区切り）
            <input
              type="text"
              value={toCsv(data.languages || [])}
              onChange={(e) => setData((d) => ({ ...(d as any), languages: toArr(e.target.value) }))}
              placeholder="ja, en"
            />
          </label>
        </div>
        <label>activity_area（カンマ区切り）
          <input
            type="text"
            value={toCsv(data.activity_area || [])}
            onChange={(e) => setData((d) => ({ ...(d as any), activity_area: toArr(e.target.value) }))}
            placeholder="tokyo, yokohama"
          />
        </label>
      </section>

      <section className="mu-card subtle">
        <h2>紹介コード</h2>
        <div className="grid-2">
          <div className="readonly-chip">
            <span>Rcode</span>
            <strong>{data.Rcode || '—'}</strong>
          </div>
          <div className="readonly-chip">
            <span>REcode</span>
            <strong>{data.REcode || '—'}</strong>
          </div>
        </div>
        <p className="hint">REcode は表示のみ（変更不可）</p>
      </section>
    </div>
  );
}
