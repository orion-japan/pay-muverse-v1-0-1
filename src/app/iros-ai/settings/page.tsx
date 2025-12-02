// src/app/iros-ai/settings/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/firebase';

// Iros の口調スタイル（他ファイルと union を揃える）
type IrosStyle = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

const STYLE_LABELS: Record<IrosStyle, string> = {
  friendly: 'フレンドリー（Muverse向け）',
  'biz-soft': 'ビジネス（やわらかめ）',
  'biz-formal': 'ビジネス（フォーマル）',
  plain: 'プレーン（フラット）',
};

const STYLE_DESCRIPTIONS: Record<IrosStyle, string> = {
  friendly:
    'いまの Iros に近い、やわらかく寄り添う丁寧語。少しくだけた表現もOK。',
  'biz-soft':
    '企業向け。敬語ベースで柔らかく、1on1や企画メモにそのまま使えるトーン。',
  'biz-formal':
    '会議・資料向け。感情表現を抑え、構造と示唆を中心に整理してくれるトーン。',
  plain:
    '装飾少なめのフラットな丁寧語。共感は一言だけ、あとは情報と選択肢の整理に集中。',
};

// localStorage のキー（フロント専用）
const STORAGE_KEY = 'iros.style';

/** プロファイルAPIに style を保存する */
async function saveStyleToServer(next: IrosStyle) {
  try {
    const user = auth.currentUser;
    const token = user ? await user.getIdToken() : null;

    if (!token) {
      console.warn('[IROS/settings] no currentUser, skip profile upsert');
      return;
    }

    const res = await fetch('/api/agent/iros/profile/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ style: next }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      console.error('[IROS/settings] profile upsert failed', res.status, body);
    } else {
      console.log('[IROS/settings] profile upsert ok', next);
    }
  } catch (e) {
    console.error('[IROS/settings] profile upsert error', e);
  }
}

export default function IrosAiSettingsPage() {
  const [style, setStyle] = useState<IrosStyle>('friendly');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // 初期読み込み（ブラウザのみ）
  useEffect(() => {
    try {
      const v =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(STORAGE_KEY)
          : null;
      if (
        v === 'friendly' ||
        v === 'biz-soft' ||
        v === 'biz-formal' ||
        v === 'plain'
      ) {
        setStyle(v);
      }
    } catch {
      // localStorage 不可の場合はデフォルト(friendly)のまま
    } finally {
      setLoaded(true);
    }
  }, []);

  // 選択変更時に localStorage + DB へ保存
  const handleChange = async (next: IrosStyle) => {
    setStyle(next);

    // localStorage
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      /* ignore */
    }

    // DB(iros_user_profile.style) へ保存
    setSaving(true);
    await saveStyleToServer(next);
    setSaving(false);
    setSavedAt(new Date());
  };

  return (
    <div style={{ padding: '24px' }}>
      {/* 戻るボタン */}
      <Link href="/iros-ai">
        <button
          type="button"
          style={{
            padding: '6px 16px',
            borderRadius: 999,
            border: '1px solid rgba(0,0,0,0.2)',
            background: '#fff',
            cursor: 'pointer',
            fontSize: '0.85rem',
            marginBottom: '20px',
          }}
        >
          ← 戻る
        </button>
      </Link>

      <h1 style={{ fontSize: '1.2rem', marginBottom: '12px' }}>Iros 設定</h1>

      <p style={{ opacity: 0.7, marginBottom: '20px', lineHeight: 1.6 }}>
        Iros の「口調スタイル」を切り替えられるようにしました。
        <br />
        ここで選んだスタイルは、ブラウザ内とプロフィールの両方に保存され、
        チャット画面から参照できるようになります。
      </p>

      {/* 口調スタイル 選択ブロック */}
      <section
        style={{
          border: '1px solid rgba(0,0,0,0.12)',
          borderRadius: 12,
          padding: '16px',
          marginBottom: '16px',
        }}
      >
        <h2 style={{ fontSize: '1rem', marginBottom: '8px' }}>🗣 口調スタイル</h2>
        <p style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: '12px' }}>
          いまは <strong>Muverse 内の Iros 全体に対して共通のスタイル</strong>{' '}
          として扱います。
        </p>

        {!loaded && (
          <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>読み込み中…</p>
        )}

        {loaded && (
          <div>
            {(Object.keys(STYLE_LABELS) as IrosStyle[]).map((key) => (
              <label
                key={key}
                style={{
                  display: 'block',
                  borderRadius: 8,
                  border:
                    style === key
                      ? '1px solid rgba(0,0,0,0.4)'
                      : '1px solid rgba(0,0,0,0.12)',
                  padding: '8px 10px',
                  marginBottom: '8px',
                  cursor: 'pointer',
                  background:
                    style === key
                      ? 'rgba(0,0,0,0.03)'
                      : 'rgba(255,255,255,1)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="radio"
                    name="iros-style"
                    value={key}
                    checked={style === key}
                    onChange={() => handleChange(key)}
                    style={{ marginRight: 6 }}
                  />
                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                      {STYLE_LABELS[key]}
                    </div>
                    <div
                      style={{
                        fontSize: '0.8rem',
                        opacity: 0.75,
                        marginTop: 2,
                        lineHeight: 1.5,
                      }}
                    >
                      {STYLE_DESCRIPTIONS[key]}
                    </div>
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </section>

      {/* 保存ステータス表示（おまけ） */}
      <section style={{ fontSize: '0.8rem', opacity: 0.8, lineHeight: 1.6 }}>
        {saving && <p>保存中です…</p>}
        {!saving && savedAt && (
          <p>サーバーに保存しました（{savedAt.toLocaleTimeString()}）</p>
        )}
      </section>
    </div>
  );
}
