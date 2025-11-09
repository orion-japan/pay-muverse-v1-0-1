import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(URL, KEY);

export type SemanticDef = {
  id: string;
  key: string;
  definition: string;
  aliases?: string[];
  status: 'draft'|'approved'|'archived';
};

export async function suggestSemanticDef(input: {
  key: string; definition: string; aliases?: string[]; user_code?: string; org_id?: string|null;
}) {
  const { data, error } = await sb.from('iros_semantic_defs').insert({
    key: input.key, definition: input.definition, aliases: input.aliases ?? null,
    created_by: input.user_code ?? null, org_id: input.org_id ?? null, status: 'draft'
  }).select('id').maybeSingle();
  if (error) throw error;
  return data?.id as string;
}

export async function approveSemanticDef(id: string, approver?: string) {
  const { data, error } = await sb.from('iros_semantic_defs')
    .update({ status: 'approved', approved_by: approver ?? null, approved_at: new Date().toISOString() })
    .eq('id', id).select('id').maybeSingle();
  if (error) throw error;
  return data?.id as string;
}

export async function getApprovedSemantic(keys: string[], org_id?: string|null) {
  const { data, error } = await sb.from('iros_semantic_defs')
    .select('key,definition,aliases,status')
    .eq('status','approved')
    .in('key', keys)
    .order('key', {ascending:true});
  if (error) throw error;
  return (data ?? []) as SemanticDef[];
}
