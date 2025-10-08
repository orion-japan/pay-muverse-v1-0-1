export async function createOcrSeed(input: {
    user_code: string;
    images: string[];   // storage に置いたURL（空でもOK）
    ocr_text: string;   // OCR本文（stage1で使う/ここでは触れない）
    meta?: any;
  }) {
    const res = await fetch('/api/agent/mui/ocr/commit', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(input)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'ocr/commit failed');
    return json as { ok: true; seed_id: string };
  }
  
  export async function saveOcrIntent(input: {
    user_code: string; seed_id: string;
    intent_text: string; intent_category?: string;
  }) {
    const res = await fetch('/api/agent/mui/ocr/intent', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(input)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'ocr/intent failed');
    return json as { ok: true };
  }

  