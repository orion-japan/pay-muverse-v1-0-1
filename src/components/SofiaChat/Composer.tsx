// src/components/SofiaChat/Composer.tsx
'use client';
import React, { useState } from 'react';
import { useMuSend } from './useMuSend';

export default function Composer({ isMaster=false }: { isMaster?: boolean }) {
  const { send, sending, conversationId } = useMuSend();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'mu'|'iros'>('mu'); // Iros切替

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const msg = text.trim();
    if (!msg) return;

    // 自分の発言を即時反映
    window.dispatchEvent(new CustomEvent('mu:user', { detail: { text: msg } }));

    try {
      const res = await send(msg, mode);
      window.dispatchEvent(new CustomEvent('mu:new-turn', { detail: res })); // MessageListへ通知
      if (res.warning) {
        const w = res.warning === 'NO_BALANCE'
          ? '残高が不足しています。チャージをご確認ください。'
          : '残りクレジットが少なくなっています。';
        window.dispatchEvent(new CustomEvent('toast', { detail: { kind:'warn', msg: w } }));
      }
    } catch {
      window.dispatchEvent(new CustomEvent('toast', { detail: { kind:'error', msg: '送信に失敗しました。少し待って再送してください。' } }));
    } finally {
      setText('');
    }
  };

  return (
    <form onSubmit={onSubmit} className="composer">
      <div className="agent-tabs">
        <button
          type="button"
          className={mode==='mu'?'on':''}
          aria-pressed={mode==='mu'}
          onClick={()=>setMode('mu')}
        >
          Mu
        </button>
        <button
          type="button"
          className={mode==='iros'?'on':''}
          aria-pressed={mode==='iros'}
          onClick={()=>setMode('iros')}
          disabled={!isMaster}
          title={isMaster?'Irosを使用':'Master限定'}
        >
          Iros
        </button>
      </div>
      <div className="row">
        <input
          value={text}
          onChange={e=>setText(e.target.value)}
          placeholder="メッセージを入力…"
        />
        <button type="submit" disabled={sending || !text.trim()}>送信</button>
      </div>

      {/* CID は存在時のみ控えめに表示 */}
      {conversationId && (
        <div className="cid" style={{ opacity:.6, fontSize:12, marginTop:4 }}>
          CID: {conversationId}
        </div>
      )}
    </form>
  );
}
