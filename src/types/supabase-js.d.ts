// 最低限のシム。実行時は実体があるため TS の型解決だけを満たす。
declare module '@supabase/supabase-js' {
  export function createClient(url: string, key: string, opts?: any): any;
  export type SupabaseClient = any;
}
