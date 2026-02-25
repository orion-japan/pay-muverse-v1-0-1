// src/components/SofiaChat/Composer.tsx
'use client';

import React, { useRef, useState } from 'react';
import { useMuSend } from './useMuSend';

export default function Composer({ isMaster = false }: { isMaster?: boolean }) {
  const { send, sending, conversationId } = useMuSend();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'mu' | 'iros'>('mu'); // Iros切替

  // 連打/二重submit対策（sending が切り替わる“前”の瞬間を塞ぐ）
  const inFlightRef = useRef(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || inFlightRef.current) return;

    const msg = text.trim();
    if (!msg) return;

    inFlightRef.current = true;

    // 送信失敗時に復元できるように保持
    const draft = text;

    // 自分の発言を即時反映（楽観描画）
    window.dispatchEvent(new CustomEvent('mu:user', { detail: { text: msg } }));

    try {
      const res = await send(msg, mode);

      // MessageListへ通知
      window.dispatchEvent(new CustomEvent('mu:new-turn', { detail: res }));

      if (res?.warning) {
        const w =
          res.warning === 'NO_BALANCE'
            ? '残高が不足しています。チャージをご確認ください。'
            : '残りクレジットが少なくなっています。';
        window.dispatchEvent(new CustomEvent('toast', { detail: { kind: 'warn', msg: w } }));
      }

      // ✅ 成功時のみ入力をクリア
      setText('');
    } catch {
      // ❗ 失敗したら入力を戻す（ユーザーが再送しやすい）
      setText(draft);

      window.dispatchEvent(
        new CustomEvent('toast', {
          detail: { kind: 'error', msg: '送信に失敗しました。少し待って再送してください。' },
        }),
      );
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <form onSubmit={onSubmit} className="composer">
      <div className="agent-tabs">
        <button
          type="button"
          className={mode === 'mu' ? 'on' : ''}
          aria-pressed={mode === 'mu'}
          onClick={() => setMode('mu')}
        >
          Mu
        </button>

        <button
          type="button"
          className={mode === 'iros' ? 'on' : ''}
          aria-pressed={mode === 'iros'}
          onClick={() => setMode('iros')}
          disabled={!isMaster}
          title={isMaster ? 'Irosを使用' : 'Master限定'}
        >
          Iros
        </button>
      </div>

      <div className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="メッセージを入力…"
          disabled={sending}
          onKeyDown={(e) => {
            // 日本語IME変換中の Enter で submit が走る事故を防ぐ
            const ne = e.nativeEvent as unknown as { isComposing?: boolean };
            if (e.key === 'Enter' && ne?.isComposing) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        />

        <button type="submit" disabled={sending || !text.trim()}>
          送信
        </button>
      </div>

      {/* CID は存在時のみ控えめに表示 */}
      {conversationId && (
        <div className="cid" style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
          CID: {conversationId}
        </div>
      )}
    </form>
  );
}
