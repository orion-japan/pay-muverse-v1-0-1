// src/components/SofiaChat/useMuSend.ts
import { useState, useCallback, useRef, useEffect } from 'react';

export type AgentResponse = {
  reply: string;
  q_code: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;
  conversation_id: string;
  sub_id: string;
  used_credits: number;
  status: 'ok' | 'error' | 'timeout' | 'unauthorized' | 'ratelimited';
  meta?: any;
  warning?: 'LOW_BALANCE' | 'NO_BALANCE' | null;
  error_message?: string;
  master_id?: string;
};

/**
 * mode別にCIDを永続化
 */
function getStorageKey(mode: 'mu' | 'iros') {
  return mode === 'iros' ? 'iros.convId' : 'mu.convId';
}

function getOrCreateConvId(mode: 'mu' | 'iros', seed?: string) {
  const k = getStorageKey(mode);
  let v = seed || localStorage.getItem(k) || '';

  if (!v) {
    v = `${mode.toUpperCase()}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    localStorage.setItem(k, v);
  }

  return v;
}

export function useMuSend(initialCid?: string) {
  const initRef = useRef(false);
  const [conversationId, setCid] = useState<string | undefined>(initialCid);
  const [sending, setSending] = useState(false);

  /**
   * 初期マウント時に localStorage を読む（mu用）
   * ※ Composer側でmodeを切り替えるため、
   *   ここではmuの既存会話だけ復元（irosは送信時に確定）
   */
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    if (!initialCid) {
      const saved = localStorage.getItem('mu.convId');
      if (saved) setCid(saved);
    }
  }, [initialCid]);

  const send = useCallback(
    async (text: string, mode: 'mu' | 'iros' = 'mu'): Promise<AgentResponse> => {
      setSending(true);

      try {
        // mode別にCIDを確定
        const cid = getOrCreateConvId(mode, conversationId);

        if (!conversationId || conversationId !== cid) {
          setCid(cid);
        }

        const res = await fetch('/api/agent/muai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            master_id: cid,
            conversation_id: cid,
            mode,
          }),
        });

        const json: AgentResponse = await res.json();

        // サーバーがCIDを付け替えた場合はそれを採用
        const resolved =
          (json.master_id && String(json.master_id)) ||
          (json.conversation_id && String(json.conversation_id)) ||
          cid;

        if (resolved) {
          const k = getStorageKey(mode);
          localStorage.setItem(k, resolved);

          if (resolved !== conversationId) {
            setCid(resolved);
          }
        }

        return json;
      } finally {
        setSending(false);
      }
    },
    [conversationId],
  );

  return { send, sending, conversationId };
}
