// scripts/embed_knowledge.mjs
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_TOKEN      = process.env.HF_TOKEN;                 // HuggingFace Inference API
const MODEL         = process.env.EMB_MODEL || 'BAAI/bge-m3';
const BATCH_LIMIT   = Number(process.env.EMB_BATCH || 20);  // 1回の処理件数

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です');
  process.exit(1);
}
if (!HF_TOKEN) {
  console.error('❌ HF_TOKEN（HuggingFaceトークン）が未設定です');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

async function getEmbedding(text) {
  const r = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HF error: ${r.status} ${t}`);
  }
  const json = await r.json();
  const v = Array.isArray(json[0]) ? json[0] : json;
  if (!Array.isArray(v)) throw new Error('Unexpected HF embedding shape');
  return v;
}

async function main() {
  // 埋め込み未設定の行を取得
  const { data: rows, error } = await sb
    .from('iros_knowledge')
    .select('id, title, content')
    .is('embedding', null)
    .limit(BATCH_LIMIT);

  if (error) throw error;
  if (!rows?.length) {
    console.log('✅ No rows to embed.');
    return;
  }

  console.log(`🟢 Embedding ${rows.length} row(s) with ${MODEL} ...`);
  for (const r of rows) {
    const text = `${r.title ?? ''}\n${r.content ?? ''}`.trim();
    const vec = await getEmbedding(text);
    const { error: upErr } = await sb
      .from('iros_knowledge')
      .update({ embedding: vec })
      .eq('id', r.id);
    if (upErr) {
      console.error('  └─ ✖ Update failed for', r.id, upErr.message);
    } else {
      console.log('  └─ ✔ Embedded:', r.id);
    }
  }
  console.log('✅ Done.');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
