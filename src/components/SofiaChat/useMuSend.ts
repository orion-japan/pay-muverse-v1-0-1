// src/components/SofiaChat/useMuSend.ts
import { useState, useCallback } from 'react';

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
};

export function useMuSend(initialCid?: string) {
  const [conversationId, setCid] = useState<string | undefined>(initialCid);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (text: string, mode: 'mu'|'iros'='mu'): Promise<AgentResponse> => {
    setSending(true);
    try {
      const res = await fetch('/api/agent/muai', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          message: text,
          conversation_id: conversationId,
          mode,
        })
      });
      const json: AgentResponse = await res.json();
      if (!conversationId && json.conversation_id) setCid(json.conversation_id);
      return json;
    } finally {
      setSending(false);
    }
  }, [conversationId]);

  return { send, sending, conversationId };
}
