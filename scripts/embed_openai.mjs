// scripts/embed_openai.mjs
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY; // ← service-role 必須
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.EMB_MODEL || 'text-embedding-3-large';
const BATCH = Number(process.env.EMB_BATCH || 5);

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY 未設定');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embedOne(row) {
  const input = `${row.title ?? ''}\n${row.content ?? ''}`.trim();
  const resp = await openai.embeddings.create({ model: MODEL, input });
  const vec = resp.data[0].embedding;
  const { error: upErr } = await sb.from('iros_knowledge').update({ embedding: vec }).eq('id', row.id);
  if (upErr) throw new Error('Update failed: ' + upErr.message);
  // verify
  const { data: after } = await sb.from('iros_knowledge').select('embedding').eq('id', row.id).single();
  const ok = !!after?.embedding;
  console.log(`  └─ ${ok ? '✔' : '✖'} id=${row.id} dim=${vec.length}`);
  return ok;
}

async function main() {
  const { data: rows, error } = await sb
    .from('iros_knowledge')
    .select('id, title, content')
    .is('embedding', null)
    .limit(BATCH);
  if (error) throw error;

  if (!rows?.length) {
    console.log('✅ 埋め込み待ちデータなし');
    return;
  }

  console.log(`🟢 ${rows.length} 件を埋め込み: model=${MODEL}`);
  for (const r of rows) {
    try {
      await embedOne(r);
    } catch (e) {
      console.error('  ✖ error on', r.id, e.message);
    }
  }

  // 集計表示
  const { data: stat } = await sb
    .from('iros_knowledge')
    .select('count:count(*)')
    .not('embedding', 'is', null);
  console.log('✅ has_embedding count:', stat?.[0]?.count ?? 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
