import { getFieldSnapshot } from '@/lib/field';

export async function readFieldForSofia(user_code: string){
  const snap = await getFieldSnapshot(user_code);
  if (!snap) return { banner: '', vars: {} as any };

  const n = snap.now || {};
  const banner =
`# Field
基準：${n.anchor || '（未設定）'}
位相：${n.vector}／深度：${n.depth}／フェーズ：${n.phase}
Q:${n.q} polarity:${(n.polarity ?? 0).toFixed(2)} sa:${(n.sa ?? 0).toFixed(2)}
`;
  return { banner, vars: n };
}
