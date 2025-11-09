// src/lib/iros/memory/ summarizeClient.ts
export async function summarize(prevMini: string, userText: string, aiText: string): Promise<string> {
  const r = await fetch('/api/iros/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ prevMini, userText, aiText })
  });
  if (!r.ok) throw new Error('summarize_failed');
  const j = await r.json();
  return String(j.summary || '');
}
