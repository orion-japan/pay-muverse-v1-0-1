// src/components/SofiaChat/useMuSend.ts
import { useState, useCallback, useRef } from 'react';

export type AgentResponse = {
  reply: string;
  q_code: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5'|null;
  conversation_id: string;
  sub_id: string;
  used_credits: number;
  status: 'ok'|'error'|'timeout'|'unauthorized'|'ratelimited';
  meta?: any;
  warning?: 'LOW_BALANCE'|'NO_BALANCE'|null;
  error_message?: string;
  // 互換: master_id が返る場合もある
  master_id?: string;
};

// 1) 一度作ったIDを永続化
function getOrCreateConvId(seed?: string) {
  const k = 'mu.convId';
  let v = seed || localStorage.getItem(k) || '';
  if (!v) {
    v = `MU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
    localStorage.setItem(k, v);
  }
  return v;
}

export function useMuSend(initialCid?: string) {
  // 2) 初期化時に localStorage を見る
  const initRef = useRef(false);
  const [conversationId, setCid] = useState<string | undefined>(initialCid);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (text: string, mode: 'mu'|'iros'='mu'): Promise<AgentResponse> => {
    setSending(true);
    try {
      // 3) 送信前にIDを必ず確定（初回のみ生成→永続化）
      const cid = getOrCreateConvId(conversationId);
      if (!conversationId) setCid(cid);

      const res = await fetch('/api/agent/muai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          // 4) 互換のため両方送る
          master_id: cid,
          conversation_id: cid,
          mode,
        }),
      });

      const json: AgentResponse = await res.json();

      // 5) サーバー側で付け替えたIDがあればそれを採用し、永続化
      const resolved =
        (json.master_id && String(json.master_id)) ||
        (json.conversation_id && String(json.conversation_id)) ||
        cid;

      if (resolved && resolved !== cid) {
        localStorage.setItem('mu.convId', resolved);
        setCid(resolved);
      } else {
        // 念のため保存
        localStorage.setItem('mu.convId', cid);
      }

      return json;
    } finally {
      setSending(false);
    }
  }, [conversationId]);

  return { send, sending, conversationId };
}
