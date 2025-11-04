// components/modals/PayjpModal.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { createCardToken } from '@/lib/mui/charge'; // 既に作成済み

type Props = {
  open: boolean;
  onClose: () => void;
  userId: string;
  stage?: 2 | 3 | 4;
  bundle?: boolean;
  price: number;
  onPaid?: () => void; // 支払い完了 → entitlement再読込 → /api/ai/phase を再実行
};

export default function PayjpModal({ open, onClose, userId, stage, bundle, price, onPaid }: Props) {
  const mountId = useRef(`payjp-card-${Math.random().toString(36).slice(2)}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setMsg(null);
  }, [open]);

  if (!open) return null;

  async function handlePay() {
    try {
      setBusy(true);
      const token = await createCardToken(`#${mountId.current}`);
      const r = await fetch('/api/payjp/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ token, stage, bundle: !!bundle, userId }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'charge_failed');
      setMsg('お支払いが完了しました。');
      onPaid?.();
      onClose();
    } catch (e: any) {
      setMsg(e?.message ?? 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
      <div className="bg-white rounded-xl p-5 w-[360px] shadow-xl">
        <h3 className="font-semibold text-lg mb-2">解放する（¥{price.toLocaleString()}）</h3>
        <div id={mountId.current} className="border rounded p-3 mb-3" />
        {msg && <p className="text-sm text-gray-600 mb-2">{msg}</p>}
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-2" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="px-4 py-2 bg-indigo-600 text-white rounded"
            onClick={handlePay}
            disabled={busy}
          >
            {busy ? '処理中…' : '支払う'}
          </button>
        </div>
      </div>
    </div>
  );
}
