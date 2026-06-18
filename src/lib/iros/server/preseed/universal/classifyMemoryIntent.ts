import type { MemoryIntent } from './types';

export function classifyMemoryIntent(userText: string): MemoryIntent {
  const text = String(userText ?? '').trim();

  if (!text) return 'unknown';

  if (/スクショ診断\s*ID[:：]?\s*\d+|スクショ診断\s*\d+/u.test(text)) {
    return 'screenshot_diagnosis_recall';
  }

  if (/(ir診断|IR診断|意図診断|診断結果|前の診断|診断の続き|診断を深め|診断を見て)/u.test(text)) {
    return 'ir_diagnosis_recall';
  }

  if (/(関係|距離感|仲|相性|恋愛|彼|彼女|相手|夫|妻|母|父|子供|友達|クライアント|先生|弟子)/u.test(text)) {
    return 'relationship_recall';
  }

  if (/(今どういう状態|現在地|どこにいる|状態|進捗|行き先|方向|ズレ|成長|移行中|定着)/u.test(text)) {
    return 'person_state_recall';
  }

  if (/(前者|後者|一つ目|二つ目|1で|2で|それで|それを|お願いします|続けて|はい)/u.test(text) && text.length <= 30) {
    return 'pending_offer_followup';
  }

  if (/(続き|さっき|この件|その件|あの件|もう少し|詳しく|それは|これは)/u.test(text)) {
    return 'active_thread_followup';
  }

  if (/(Muverse|Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|Git|Next\.js|route\.ts|コード|PowerShell|typecheck|npm|実装|修正|エラー|ビルド|デプロイ)/iu.test(text)) {
    return 'project_context_recall';
  }

  if (/(前のルール|作業ルール|いつものルール|覚えて|設定|仕様|方針)/u.test(text)) {
    return 'working_rule_recall';
  }

  return 'normal_chat';
}
