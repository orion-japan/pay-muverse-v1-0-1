'use client';

import React, { useEffect, useState } from 'react';
import {
  PeriodBundleList,
  type ResonancePeriodBundle,
  type PeriodType,
} from '@/lib/iros/remember/PeriodBundleList';
import { irosRememberBundles } from '@/lib/iros/irosClient';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

type BundlesResponse = {
  ok: boolean;
  period_type: PeriodType;
  tenant_id: string;
  bundles: ResonancePeriodBundle[];
  error?: string;
  detail?: string;
};

const PERIOD_OPTIONS: { value: PeriodType; label: string }[] = [
  { value: 'day', label: '日ごと' },
  { value: 'week', label: '週ごと' },
  { value: 'month', label: '月ごと' },
];

export default function RememberPage() {
  const [period, setPeriod] = useState<PeriodType>('month');
  const [bundles, setBundles] = useState<ResonancePeriodBundle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔑 Firebase Auth の準備完了フラグ
  const [authReady, setAuthReady] = useState(false);
  const [requireLogin, setRequireLogin] = useState(false);

  // ① Auth 状態の監視。準備完了したら authReady = true
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setAuthReady(true);
      setRequireLogin(!fbUser); // ユーザーがいなければログイン必須扱い
    });
    return () => unsub();
  }, []);

  // ② Auth 準備完了 ＋ ログイン済み のときだけ Remember API を呼ぶ
  useEffect(() => {
    let cancelled = false;

    // Auth がまだなら何もしない
    if (!authReady) return;

    // ログインしていない場合はエラー表示だけして API は叩かない
    if (requireLogin) {
      setError('ログイン状態が確認できませんでした。再ログインしてください。');
      setBundles([]);
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = (await irosRememberBundles({
          period,
          limit: 30,
        })) as BundlesResponse;

        if (!data.ok) {
          throw new Error(data.error || 'failed to load bundles');
        }

        if (!cancelled) {
          setBundles(data.bundles ?? []);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? '読み込み中にエラーが発生しました');
          setBundles([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [period, authReady, requireLogin]);

  return (
    <div style={{ maxWidth: 800, margin: '24px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Remember バンドル一覧</h1>
      <p style={{ fontSize: 14, color: '#555', marginBottom: 16 }}>
        Iros がまとめた「期間ごとの振り返り（Rememberバンドル）」を一覧できます。
      </p>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setPeriod(opt.value)}
            style={{
              padding: '6px 10px',
              borderRadius: 999,
              border:
                opt.value === period ? '1px solid #333' : '1px solid #ccc',
              backgroundColor: opt.value === period ? '#333' : '#fff',
              color: opt.value === period ? '#fff' : '#333',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {!authReady && (
        <div style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>
          認証状態を確認しています…
        </div>
      )}

      {requireLogin && authReady && (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            borderRadius: 8,
            border: '1px solid #f5c2c7',
            backgroundColor: '#f8d7da',
            color: '#842029',
            fontSize: 13,
          }}
        >
          ログイン情報が見つかりませんでした。いったんログインし直してから、再度お試しください。
        </div>
      )}

      {loading && !requireLogin && (
        <div style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>
          読み込み中です…
        </div>
      )}

      {error && !requireLogin && (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            borderRadius: 8,
            border: '1px solid #f5c2c7',
            backgroundColor: '#f8d7da',
            color: '#842029',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {!requireLogin && <PeriodBundleList bundles={bundles} />}
    </div>
  );
}
