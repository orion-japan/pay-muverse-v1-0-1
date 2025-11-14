// src/app/intention-gallery/page.tsx
// 公開済みの意図プロンプト一覧（閲覧専用ギャラリー）
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export default async function IntentionGalleryPage() {
  const { data, error } = await supabaseAdmin
    .from('intention_prompts')
    .select('id, title, author_name, t_layer, mood, created_at')
    .eq('visibility', '公開')
    .order('created_at', { ascending: false })
    .limit(30);

  return (
    <main style={wrap}>
      <h1 style={h1}>🪔 Intention Gallery（公開一覧）</h1>

      {error && (
        <div style={errorBox}>読み込みエラー: {error.message}</div>
      )}

      {!data?.length && !error && (
        <div style={emptyBox}>まだ公開作品がありません。</div>
      )}

      {data?.length ? (
        <ul style={list}>
          {data.map((r) => (
            <li key={r.id} style={item}>
              <div style={meta}>
                <span style={tLayer}>{r.t_layer}</span>
                <span style={mood}>{r.mood ?? '—'}</span>
                <span style={author}>{r.author_name ?? '匿名'}</span>
                <span style={date}>
                  {new Date(r.created_at).toLocaleString('ja-JP')}
                </span>
              </div>
              <Link href={`/intention-prompt/${r.id}`} style={titleLink}>
                {r.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

/* ===== スタイル群 ===== */
const wrap: React.CSSProperties = {
  padding: '32px',
  maxWidth: 960,
  margin: '0 auto',
  fontFamily: 'system-ui, sans-serif',
};

const h1: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 20,
};

const list: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const item: React.CSSProperties = {
  border: '1px solid #e5e5e5',
  borderRadius: 10,
  padding: 16,
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
};

const titleLink: React.CSSProperties = {
  display: 'block',
  fontSize: 16,
  color: '#0b57d0',
  textDecoration: 'none',
  fontWeight: 600,
  marginTop: 8,
};

const meta: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const tLayer: React.CSSProperties = { color: '#444', fontWeight: 600 };
const mood: React.CSSProperties = { color: '#0b57d0' };
const author: React.CSSProperties = { color: '#333' };
const date: React.CSSProperties = { marginLeft: 'auto', color: '#888' };

const errorBox: React.CSSProperties = {
  padding: 16,
  border: '1px solid #f3c2c2',
  background: '#fff5f5',
  borderRadius: 8,
  color: '#b00020',
};

const emptyBox: React.CSSProperties = {
  padding: 16,
  border: '1px dashed #ccc',
  borderRadius: 8,
  textAlign: 'center',
  color: '#777',
};
