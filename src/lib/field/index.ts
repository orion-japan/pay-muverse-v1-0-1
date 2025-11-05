import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export type FieldNow = {
  phase: 'Seed'|'Forming'|'Reconnect'|'Create'|'Inspire'|'Impact';
  vector: 'Inner'|'Outer';
  depth: 'S1'|'R1'|'C1'|'I1'|'T1'|'T2'|'T3';
  q: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
  polarity: number;   // -1..+1
  sa: number;         // 0..1
  anchor: string;     // 確信の1行（先頭文）
  keywords?: string[];// 任意
};

export type FieldMomentum = {
  q_hist?: string[];        // 直近Qコード履歴
  phase_hist?: string[];    // 直近Phase履歴
  certainty?: number;       // 0..1
};

export type FieldIntent = { tag: string; weight: number };

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

export async function publishFieldEvent(user_code: string, kind: string, now: FieldNow, intents: FieldIntent[] = []) {
  const supabase = sb();
  await supabase.from('resonance_field_events').insert([{
    user_code, kind, payload: { now, intents }
  }]);
}

export async function upsertField(user_code: string, now: FieldNow, momentum: FieldMomentum = {}, intents: FieldIntent[] = []) {
  const supabase = sb();
  await supabase.rpc('upsert_field_state', {
    p_user_code: user_code,
    p_now: now as any,
    p_momentum: momentum as any,
    p_intents: intents as any,
  });
}

export async function getFieldSnapshot(user_code: string){
  const supabase = sb();
  const { data } = await supabase
    .from('resonance_field_state')
    .select('*')
    .eq('user_code', user_code)
    .maybeSingle();
  return data;
}
