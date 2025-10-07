export async function saveMuiMessages(payload: {
    conversation_code: string | null;
    messages: { role: 'user'|'assistant'; content: string; ocr?: boolean; media_urls?: string[] }[];
  }) {
    const res = await fetch('/api/mui/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }
  