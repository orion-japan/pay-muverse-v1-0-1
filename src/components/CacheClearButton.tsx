// src/components/CacheClearButton.tsx
'use client';

import { useState } from 'react';

type Props = {
  /** クリア後に保持したい localStorage のキー（例：ユーザー設定など） */
  keepLocalKeys?: string[];
  /** 完了後の動作: 'reload' | 'none'（既定は reload） */
  onDone?: 'reload' | 'none';
};

export default function CacheClearButton({ keepLocalKeys = [], onDone = 'reload' }: Props) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function clearSW() {
    if (!('serviceWorker' in navigator)) return { sw: 0 };
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs.map(async (r) => {
        try {
          // 即時停止を促す（対応していれば）
          r.active?.postMessage?.({ type: 'SKIP_WAITING' });
        } catch {}
        try {
          await r.unregister();
        } catch {}
      })
    );
    return { sw: regs.length };
  }

  async function clearCaches() {
    if (!('caches' in window)) return { caches: 0 };
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    return { caches: keys.length };
  }

  function clearStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        const keep = new Set(keepLocalKeys);
        const survivors: Record<string, string> = {};
        // 退避
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && keep.has(k)) survivors[k] = localStorage.getItem(k) ?? '';
        }
        localStorage.clear();
        // 復元
        Object.entries(survivors).forEach(([k, v]) => localStorage.setItem(k, v));
      }
    } catch {}
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
    } catch {}
    return { storage: true };
  }

  async function handleClick() {
    if (running) return;
    const ok = window.confirm(
      'キャッシュをクリアします。オフラインデータや古いUIが削除されます。よろしいですか？'
    );
    if (!ok) return;

    setRunning(true);
    setMsg('キャッシュを削除しています…');

    try {
      const [sw, cs] = await Promise.all([clearSW(), clearCaches()]);
      clearStorage();

      setMsg(`完了: Service Worker ${sw.sw} 件 / Cache ${cs.caches} 件を削除しました。`);

      // iOS Safari / PWA で強制的に最新を取るためキャッシュバスター付きで再読み込み
      if (onDone === 'reload') {
        const url = new URL(window.location.href);
        url.searchParams.set('_v', String(Date.now()));
        // 少し待ってから
        setTimeout(() => {
          window.location.replace(url.toString());
        }, 400);
      }
    } catch (e) {
      console.error('[CacheClearButton] failed:', e);
      setMsg('失敗しました。手動でブラウザのサイトデータ削除をお試しください。');
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={running}
        aria-busy={running}
        style={{
          padding: '10px 14px',
          borderRadius: 12,
          border: '1px solid #bbb',
          background: running ? '#ddd' : '#fff',
          fontSize: 14,
          cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        {running ? '実行中…' : 'キャッシュをクリア'}
      </button>
      {msg && (
        <div
          role="status"
          style={{
            fontSize: 12,
            color: '#444',
            lineHeight: 1.4,
          }}
        >
          {msg}
        </div>
      )}
      <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        ※ 古い UI（例: mu_fll の専用ヘッダー）が残る端末向けの対策です。
      </p>
    </div>
  );
}
