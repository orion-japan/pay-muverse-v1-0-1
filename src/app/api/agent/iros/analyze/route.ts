// src/app/api/agent/iros/analyze/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);

type Role = 'user' | 'assistant' | 'system';
interface ConvRow { id: string; user_code: string }

function resolveUserCode(auth: any, req: NextRequest) {
  const headerUserCode = req.headers.get('x-user-code');
  const queryUserCode = req.nextUrl.searchParams.get('user_code');
  return (
    headerUserCode ||
    queryUserCode ||
    auth?.user?.user_code ||
    auth?.userCode ||
    auth?.jwt?.sub ||
    auth?.user?.uid ||
    ''
  );
}

// ---- 簡易スコア（レスポンス用のみ）----
const NEG = ['つらい','不安','怖い','無理','嫌','怒り','疲れ','しんどい','泣'];
const POS = ['嬉しい','安心','好き','大丈夫','楽しい','幸せ','助かる','ありがとう'];
const clamp01 = (n:number)=>Math.max(0,Math.min(1,n));
function estimatePolarity(t:string){const p=POS.reduce((a,w)=>a+(t.includes(w)?1:0),0);const n=NEG.reduce((a,w)=>a+(t.includes(w)?1:0),0);if(p===0&&n===0)return 0;return (p-n)/(p+n)}
function estimateSelfAcceptance(t:string){const self=['私','わたし','自分','僕','わたくし'];const accept=['大丈夫','受け入れる','許す','落ち着く','呼吸'];const deny=['無理','ダメ','できない','嫌い','否定'];const s=self.some(w=>t.includes(w))?0.1:0;const a=accept.reduce((acc,w)=>acc+(t.includes(w)?0.15:0),0);const d=deny.reduce((acc,w)=>acc+(t.includes(w)?0.15:0),0);return clamp01(0.5+s+a-d)}
function estimateQ(t:string){if(/怒り|成長|挑戦|突破/.test(t))return'Q2';if(/不安|安定|迷い|疑い/.test(t))return'Q3';if(/恐れ|浄化|手放す|清め/.test(t))return'Q4';if(/情熱|空虚|燃える|衝動/.test(t))return'Q5';return'Q1'}
function estimatePhase(t:string){const i=['感じ','内側','心','内観','静けさ'];const o=['相手','仕事','世界','関係','環境'];const ic=i.reduce((a,w)=>a+(t.includes(w)?1:0),0);const oc=o.reduce((a,w)=>a+(t.includes(w)?1:0),0);return ic>=oc?'Inner':'Outer'}
function estimateLayer(t:string){if(/(祈り|存在|意図|源|本質)/.test(t))return'I1';if(/(創る|設計|表現|構築)/.test(t))return'C1';if(/(関係|共鳴|つながり|場)/.test(t))return'R1';return'S1'}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) {
      return NextResponse.json({ ok:false, error: auth?.error || 'unauthorized' }, { status: 401 });
    }
    const userCode = String(resolveUserCode(auth, req) || '');
    if (!userCode) return NextResponse.json({ ok:false, error:'no user_code' }, { status:400 });

    let body: any = {};
    try { body = await req.json(); } catch {}
    const conversation_id: string = String(body?.conversation_id || '');
    const text: string = String(body?.text ?? '');

    if (!conversation_id) return NextResponse.json({ ok:false, error:'missing_conversation_id' }, { status:400 });
    if (!text.trim())       return NextResponse.json({ ok:false, error:'text_empty' }, { status:400 });

    // 所有者確認
    const { data: conv, error: convErr } = await sb
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .single<ConvRow>();

    if (convErr || !conv) return NextResponse.json({ ok:false, error:'conversation_not_found' }, { status:404 });
    if (String(conv.user_code) !== userCode) return NextResponse.json({ ok:false, error:'forbidden' }, { status:403 });

    // 解析（レスポンス用）
    const polarity = estimatePolarity(text);
    const sa = estimateSelfAcceptance(text);
    const q_primary = estimateQ(text);
    const phase = estimatePhase(text);
    const layer = estimateLayer(text);

    // ★ 制約対応：role は 'assistant' を使用（テーブルのCHECKに合わせる）
    const now = new Date().toISOString();
    const { data: ins, error: insErr } = await sb
      .from('iros_messages')
      .insert([{
        conversation_id,
        user_code: userCode,
        role: 'assistant' as Role, // ← ここを 'assistant' に
        text,            // text列がある場合
        content: text,   // content列しかない場合の保険
        created_at: now,
      }])
      .select('id')
      .single();

    if (insErr || !ins) {
      return NextResponse.json(
        { ok:false, error:'db_insert_failed', detail: insErr?.message || null },
        { status:500 }
      );
    }

    return NextResponse.json({
      ok: true,
      q_primary,
      sa,
      polarity,
      phase,
      layer,
      message_id: String(ins.id),
    }, { status: 200 });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || 'internal error' }, { status:500 });
  }
}
