// src/app/intention-prompt/[id]/page.tsx
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type Row = {
  id: string;
  created_at: string;
  title: string;
  author_name: string | null;
  target_label: string | null;
  t_layer: 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
  mood: string | null;
  visibility: '公開' | '非公開';
  prompt_text: string;
  form_payload: any;
  finetune_payload: any;
  share_url: string | null;
  lat: number | null;
  lon: number | null;
};

export default async function DetailPage({
  // ★ Next.js 15 では Promise で渡ってくる
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // ★ 必ず await する
  const { id } = await params;

  const { data, error } = await supabaseAdmin
    .from('intention_prompts')
    .select(
      `id, created_at, title, author_name, target_label, t_layer, mood, visibility,
       prompt_text, form_payload, finetune_payload, share_url, lat, lon`,
    )
    .eq('id', id)
    .single();

  if (error || !data) {
    return (
      <div style={wrap}>
        <h1 style={h1}>Intention Prompt Detail</h1>
        <div style={errorBox}>
          <div>読み込みエラー or データなし</div>
          <div><b>id</b>: {id ?? '(undefined)'}</div>
          <div><b>error</b>: {error?.message ?? 'no data'}</div>
          <div><Link href="/intention-gallery" style={link}>← Galleryへ戻る</Link></div>
        </div>
      </div>
    );
  }

  const row = data as Row;

  return (
    <div style={wrap}>
      <Link href="/intention-gallery" style={link}>← Galleryへ戻る</Link>
      <h1 style={h1}>Intention Prompt Detail</h1>

      <section style={metaBox}>
        <h2 style={h2}>{row.title}</h2>
        <div style={metaLine}><span style={metaLabel}>作者：</span>{row.author_name ?? '-'}</div>
        <div style={metaLine}><span style={metaLabel}>対象：</span>{row.target_label ?? '-'}</div>
        <div style={metaLine}><span style={metaLabel}>T層：</span>{row.t_layer}</div>
        <div style={metaLine}><span style={metaLabel}>心の状態：</span>{row.mood ?? '-'}</div>
        <div style={metaLine}><span style={metaLabel}>座標：</span>{row.lat ?? '—'}, {row.lon ?? '—'}</div>
        <div style={metaLine}><span style={metaLabel}>作成日時：</span>{new Date(row.created_at).toLocaleString('ja-JP')}</div>
        {row.share_url && (
          <div style={metaLine}>
            <a href={row.share_url} style={link} target="_blank" rel="noopener noreferrer">🔗 復元URLで開く</a>
          </div>
        )}
      </section>

      <section style={section}>
        <h2 style={h2}>生成されたプロンプト</h2>
        <textarea style={output} value={row.prompt_text} rows={20} readOnly />
      </section>

      <section style={section}>
        <h2 style={h2}>入力フォーム</h2>
        <pre style={jsonBox}>{JSON.stringify(row.form_payload, null, 2)}</pre>
      </section>

      {row.finetune_payload && (
        <section style={section}>
          <h2 style={h2}>微調整パラメータ</h2>
          <pre style={jsonBox}>{JSON.stringify(row.finetune_payload, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

/* styles */
const wrap: React.CSSProperties = { padding: 24, maxWidth: 1000, margin: '0 auto', fontFamily: 'system-ui, sans-serif' };
const h1: React.CSSProperties = { fontSize: 22, margin: '0 0 16px', fontWeight: 700 };
const h2: React.CSSProperties = { fontSize: 18, margin: '8px 0', fontWeight: 600 };
const metaBox: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff', marginBottom: 20 };
const metaLine: React.CSSProperties = { fontSize: 14, margin: '4px 0' };
const metaLabel: React.CSSProperties = { opacity: 0.7, marginRight: 6 };
const section: React.CSSProperties = { border: '1px solid #eee', borderRadius: 8, padding: 16, background: '#fff', marginBottom: 20 };
const output: React.CSSProperties = { width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: '1px solid #ccc', borderRadius: 6, background: '#f9fafb', padding: 12 };
const jsonBox: React.CSSProperties = { background: '#f6f6f6', border: '1px solid #ddd', borderRadius: 8, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap' as any, wordBreak: 'break-all' };
const link: React.CSSProperties = { color: '#0b57d0', textDecoration: 'underline' };
const errorBox: React.CSSProperties = { padding: 16, border: '1px solid #f3c2c2', background: '#fff5f5', borderRadius: 8, color: '#b00020' };
