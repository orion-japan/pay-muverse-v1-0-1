'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authedFetch, useAuth } from '@/context/AuthContext';
import type { MuFirstAnalyzeResponse, MuFirstStatusResponse } from '@/lib/mu-first/types';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024;

export default function MuFirstPage() {
  const router = useRouter();
  const { loading: authLoading, user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [completed, setCompleted] = useState(false);

  const canAnalyze = useMemo(() => !!file && !loading && (credit ?? 0) > 0, [file, loading, credit]);

  useEffect(() => {
    if (authLoading || !user) return;

    let alive = true;
    setStatusLoading(true);

    authedFetch('/api/mu-first/analyze', { method: 'GET' })
      .then(async (res) => (await res.json()) as MuFirstStatusResponse)
      .then((json) => {
        if (!alive) return;
        if (json.ok) {
          setCredit(json.screenshotCreditCount);
          setCompleted(json.firstScreenshotCompleted);
        }
      })
      .finally(() => {
        if (alive) setStatusLoading(false);
      });

    authedFetch('/api/mu-journey/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'page_view',
        source: 'app',
        pagePath: '/mu-first',
        metadata: { area: 'first_screenshot' },
      }),
    }).catch(() => {});

    return () => {
      alive = false;
    };
  }, [authLoading, user]);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setError(null);
    setResult(null);

    if (!selected) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    if (!ACCEPTED.includes(selected.type)) {
      setError('画像はPNG、JPEG、WebPのみ対応しています。');
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    if (selected.size > MAX_SIZE) {
      setError('画像サイズは5MB以内にしてください。');
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  }

  async function analyze() {
    if (!file) return;
    setLoading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('image', file);

      const params = new URLSearchParams(window.location.search);
      const mediaCode = params.get('media_code') || params.get('mcode') || params.get('source');
      if (mediaCode) form.append('media_code', mediaCode);

      const res = await authedFetch('/api/mu-first/analyze', {
        method: 'POST',
        body: form,
      });
      const json = (await res.json()) as MuFirstAnalyzeResponse;

      if (!res.ok || !json.ok) {
        throw new Error(json.ok ? '診断に失敗しました。' : json.error);
      }

      setResult(json.result);
      setCredit(json.screenshotCreditRemaining);
      setCompleted(true);
    } catch (e: any) {
      setError(e?.message || '診断に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) return <main style={styles.center}>確認中です…</main>;

  if (!user) {
    return (
      <main style={styles.shell}>
        <section style={styles.card}>
          <h1 style={styles.title}>ログインが必要です</h1>
          <p style={styles.text}>初回スクショ診断を使うには、登録またはログインを完了してください。</p>
          <button style={styles.button} onClick={() => router.push('/')}>
            登録ページへ戻る
          </button>
        </section>
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <section style={styles.card}>
        <p style={styles.kicker}>初回スクショ診断</p>
        <h1 style={styles.title}>LINEやDMのスクショを1枚アップロードしてください。</h1>
        <p style={styles.text}>
          この診断では、相手の本心や未来を断定しません。見えている会話の範囲から、温度差、返信の間、あなたが反応している言葉を見ます。
        </p>

        <div style={styles.notice}>
          名前・電話番号・住所などは隠して送ってください。緊急性のある相談、暴力、自傷に関する内容は扱えません。
        </div>

        <div style={styles.creditBox}>
          {statusLoading ? '診断クレジットを確認中…' : `スクショ診断クレジット：残り ${credit ?? 0} 回`}
          {completed ? <span style={styles.done}>初回診断済み</span> : null}
        </div>

        {!result ? (
          <>
            <label style={styles.upload}>
              <input type="file" accept={ACCEPTED.join(',')} onChange={onFileChange} style={{ display: 'none' }} />
              スクショを選ぶ
            </label>

            {previewUrl ? <img src={previewUrl} alt="選択したスクショ" style={styles.preview} /> : null}

            {error ? <p style={styles.error}>{error}</p> : null}

            <button style={{ ...styles.button, opacity: canAnalyze ? 1 : 0.45 }} disabled={!canAnalyze} onClick={analyze}>
              {loading ? '診断中…' : '診断する'}
            </button>
          </>
        ) : (
          <div style={styles.resultBox}>
            <p style={styles.result}>{result}</p>
            <p style={styles.text}>この続きは、Muにそのまま話しかけられます。登録特典の90クレジットで体験できます。</p>
            <button style={styles.button} onClick={() => router.push('/mu')}>
              Muと話してみる
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 20, background: '#f7f7f8' },
  center: { minHeight: '100dvh', display: 'grid', placeItems: 'center' },
  card: { width: '100%', maxWidth: 430, background: '#fff', borderRadius: 24, padding: 24, boxShadow: '0 16px 40px rgba(0,0,0,0.08)' },
  kicker: { margin: 0, fontSize: 13, color: '#8a6a4f', fontWeight: 700 },
  title: { margin: '10px 0 12px', fontSize: 24, lineHeight: 1.35, color: '#222' },
  text: { fontSize: 15, lineHeight: 1.8, color: '#444' },
  notice: { margin: '16px 0', padding: 14, borderRadius: 14, background: '#fff7ed', color: '#6b4a2e', fontSize: 13, lineHeight: 1.7 },
  creditBox: { margin: '16px 0', padding: 12, borderRadius: 14, background: '#f1f5f9', fontSize: 13, color: '#334155' },
  done: { display: 'inline-block', marginLeft: 8, fontSize: 12, color: '#0f766e', fontWeight: 700 },
  upload: { display: 'grid', placeItems: 'center', minHeight: 88, margin: '16px 0', border: '1px dashed #c7c7c7', borderRadius: 18, cursor: 'pointer', color: '#555', fontWeight: 700 },
  preview: { width: '100%', borderRadius: 18, display: 'block', margin: '0 0 16px', border: '1px solid #eee' },
  button: { width: '100%', border: 'none', borderRadius: 999, padding: '14px 18px', background: '#222', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' },
  error: { color: '#dc2626', fontSize: 13, lineHeight: 1.6 },
  resultBox: { marginTop: 18 },
  result: { whiteSpace: 'pre-wrap', lineHeight: 1.9, fontSize: 15, background: '#f8fafc', borderRadius: 18, padding: 16, color: '#263238' },
};
