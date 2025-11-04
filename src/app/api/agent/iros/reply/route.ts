// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

import { detectWantsStructure, detectIsDark, deriveFinalMode, type Mode } from '@/lib/iros/intent';
import { buildSystemPrompt, type Analyze } from '@/lib/iros/system';
import { STRUCTURE_TEMPLATE, DARK_TEMPLATE, ensureContinuationTail } from '@/lib/iros/templates';
import { chatComplete } from '@/lib/iros/openai';
import { parrotScore } from '@/lib/iros/rewrite';

// ===== util =====
const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);
const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

// ===== const =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL_DEFAULT = 'gpt-4o';

// ===== simple analyzers (既存互換) =====
const NEG = ['つらい','不安','怖い','無理','嫌','怒り','疲れ','しんどい','泣'];
const POS = ['嬉しい','安心','好き','大丈夫','楽しい','幸せ','助かる','ありがとう'];
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
function estimatePolarity(t: string){const p=POS.reduce((a,w)=>a+(t.includes(w)?1:0),0);const n=NEG.reduce((a,w)=>a+(t.includes(w)?1:0),0);if(p===0&&n===0)return 0;return (p-n)/(p+n);}
function estimateSelfAcceptance(t: string){const self=['私','わたし','自分','僕','わたくし'];const accept=['大丈夫','受け入れる','許す','落ち着く','呼吸'];const deny=['無理','ダメ','できない','嫌い','否定'];const s=self.some(w=>t.includes(w))?0.1:0;const a=accept.reduce((acc,w)=>acc+(t.includes(w)?0.15:0),0);const d=deny.reduce((acc,w)=>acc+(t.includes(w)?0.15:0),0);return clamp01(0.5+s+a-d);}
function estimateQ(t: string){if(/(怒り|成長|挑戦|突破)/.test(t))return'Q2';if(/(不安|安定|迷い|疑い)/.test(t))return'Q3';if(/(恐れ|浄化|手放す|清め)/.test(t))return'Q4';if(/(情熱|空虚|燃える|衝動)/.test(t))return'Q5';return'Q1';}
function estimatePhase(t: string){const i=['感じ','内側','心','内観','静けさ'];const o=['相手','仕事','世界','関係','環境'];const ic=i.reduce((a,w)=>a+(t.includes(w)?1:0),0);const oc=o.reduce((a,w)=>a+(t.includes(w)?1:0),0);return ic>=oc?'Inner':'Outer';}
function estimateLayer(t: string){if(/(祈り|存在|意図|源|本質)/.test(t))return'I1';if(/(創る|設計|表現|構築)/.test(t))return'C1';if(/(関係|共鳴|つながり|場)/.test(t))return'R1';return'S1';}

type Role = 'user' | 'assistant' | 'system';
type OutMsg = { id: string; role: 'assistant'; content: string; created_at: string | null };

export async function OPTIONS(){ return json({ ok:true }); }

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok:false, error:'missing_openai_api_key' }, 500);

    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok:false, error:authz.error }, authz.status);
    if (!authz.allowed) return json({ ok:false, error:'forbidden' }, 403);

    const userCode: string =
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (typeof (authz.user as any)?.uid === 'string' && (authz.user as any).uid) || '';
    if (!userCode) return json({ ok:false, error:'user_code_missing' }, 400);

    let body:any={}; try{ body = await req.json(); } catch {}
    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const user_text: string = String(body?.user_text ?? '').trim();
    const reqMode: Mode = (String(body?.mode || 'Light') as Mode);
    const model = String(body?.model || MODEL_DEFAULT);
    if (!conversation_id) return json({ ok:false, error:'missing_conversation_id' }, 400);
    if (!user_text) return json({ ok:false, error:'user_text_empty' }, 400);

    const supabase = sb();
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations').select('id,user_code').eq('id', conversation_id).maybeSingle();
    if (convErr) return json({ ok:false, error:'conv_select_failed', detail: convErr.message }, 500);
    if (!conv)  return json({ ok:false, error:'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode)) return json({ ok:false, error:'forbidden_owner_mismatch' }, 403);

    // ---- intent / analysis ----
    const wantsStructure = detectWantsStructure(user_text);
    const isDark = detectIsDark(user_text);
    const finalMode = deriveFinalMode(reqMode, user_text);

    const a: Analyze = {
      polarity: typeof body?.analysis?.polarity === 'number' ? body.analysis.polarity : estimatePolarity(user_text),
      sa:       typeof body?.analysis?.sa       === 'number' ? body.analysis.sa       : estimateSelfAcceptance(user_text),
      q_primary:(body?.analysis?.q_primary as any) || estimateQ(user_text),
      phase:    (body?.analysis?.phase as any)    || estimatePhase(user_text),
      layer:    (body?.analysis?.layer as any)    || estimateLayer(user_text),
    };

    // ---- build prompts ----
    let system = buildSystemPrompt(finalMode, a, wantsStructure, isDark);
    const userMsg = [
      '次の入力に共鳴し、モードの制約内で応答してください。',
      '禁止: 断定助言・長文・過度な反復。',
      `入力: 「${user_text}」`,
    ].join('\n');

    // ---- LLM ----
    let content = await chatComplete({
      apiKey: OPENAI_API_KEY,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: userMsg },
      ],
      temperature: 0.7,
      max_tokens: 420,
    });

    if (!content) return json({ ok:false, error:'empty_model_output' }, 502);

    // ---- refine: parrot suppress + continuation tail ----
    const score = parrotScore(user_text, content);
    const tooShort = content.replace(/\s+/g,'').length < 12;
    if (score >= 0.58 || tooShort) {
      // 短い安全なリフレーズ
      content = isDark
        ? '闇の輪郭を受け取りました。いま手放したいひとつを、静かに言葉にしてみませんか？'
        : '受け止めています。その奥の静けさを一語で表すと何ですか？';
    }
    content = ensureContinuationTail(content);

    // ---- DB保存 ----
    const nowIso = new Date().toISOString();
    const { data: ins, error: insErr } = await supabase
      .from('iros_messages')
      .insert([{
        conversation_id,
        user_code: userCode,
        role: 'assistant' as Role,
        content,
        text: content,
        created_at: nowIso,
        ts: Date.now(),
        analysis: { mode: finalMode, ...a, parrot_score: score },
        q_code: a.q_primary,
      }])
      .select('id,created_at').single();

    if (insErr || !ins) return json({ ok:false, error:'db_insert_failed', detail: insErr?.message }, 500);

    const out: OutMsg = { id: String(ins.id), role:'assistant', content, created_at: ins.created_at ?? nowIso };
    return json({ ok:true, message: out }, 200);

  } catch (e:any) {
    return json({ ok:false, error:'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
