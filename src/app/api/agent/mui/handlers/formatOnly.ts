// 最小依存の整形ハンドラ

type MuiBodyLocal = {
  text?: string;
  instruction?: string;
};

function isLikelyReply(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return /^(了解|わかりました|それはいい考え|おすすめ|〜してみて|ですね|でしょう)/m.test(t);
}

function simpleFormat(raw: string): string {
  const lines = String(raw ?? '').split(/\r?\n/);
  const out: string[] = [];
  const endOK = /[。！？!?…」』）)】]$/;
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    if (/^【#\d+】$/.test(s)) {
      out.push(s);
      continue;
    }
    if (/^[AB] /.test(s)) {
      out.push(s);
      continue;
    }
    if (!out.length) {
      out.push(s);
      continue;
    }
    const prev = out[out.length - 1];
    if (!endOK.test(prev)) out[out.length - 1] = `${prev}${s.startsWith('、') ? '' : ' '}${s}`;
    else out.push(s);
  }
  return out.join('\n');
}

function polishJaKeepLabels(raw: string): string {
  let s = String(raw ?? '');
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/\s*([。！？…、，,.!?])/g, '$1')
    .replace(/([「『（(【])\s+/g, '$1')
    .replace(/\s+([」』）)】])/g, '$1')
    .replace(/([ぁ-んァ-ヶ一-龥ー])\s+(?=[ぁ-んァ-ヶ一-龥ー])/g, '$1')
    .replace(/\?/g, '？')
    .replace(/^【出力】\s*/gim, '')
    .replace(/^出力[:：]\s*/gim, '')
    .replace(/^整形結果[:：]\s*/gim, '')
    .replace(/(\n){3,}/g, '\n\n')
    .trim();
  return s;
}

export async function handleFormatOnly(
  raw: MuiBodyLocal,
  callOpenAI: (p: any) => Promise<any>,
  model: string,
  temperature: number,
  top_p: number,
) {
  const targetText = (typeof raw.text === 'string' && raw.text.trim()) || '';
  if (!targetText) return { status: 200, body: { ok: true, formatted: '', mode: 'format_only' } };

  const SYS_FMT = [
    'あなたは日本語の「整形器」です。意味や内容は一切改変せず、読みやすく直すだけに徹してください。',
    '要件：誤字の軽微修正、不要記号の除去、句読点整理、自然な改行。A/Bなどの話者ラベルや【#n】見出しは必ず保持。',
    'NG：追加の助言・要約・解釈・絵文字追加・追記文。出力は整形済み本文のみ。',
    (raw.instruction || '').trim(),
  ]
    .filter(Boolean)
    .join('\n');

  const payloadFmt = {
    model,
    messages: [
      { role: 'system', content: SYS_FMT },
      { role: 'user', content: targetText },
    ],
    temperature: Math.min(0.3, temperature),
    top_p,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  let formatted = '';
  const aiFmt = await callOpenAI(payloadFmt);
  if (aiFmt?.ok) formatted = String(aiFmt.data?.choices?.[0]?.message?.content ?? '').trim();
  if (!formatted || isLikelyReply(formatted)) formatted = simpleFormat(targetText);
  formatted = polishJaKeepLabels(formatted);

  return { status: 200, body: { ok: true, formatted, mode: 'format_only' } };
}
