import { createClient } from '@supabase/supabase-js';
import { loadRecentHistoryAcrossConversations } from './src/lib/iros/server/historyX';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_*_KEY');
    process.exit(1);
  }

  const sb = createClient(url, key);

  const userCode = process.env.IROS_USER_CODE || '669933';

  const rows = await loadRecentHistoryAcrossConversations({
    supabase: sb,
    userCode,
    limit: 60,
  });

  const roleCounts = rows.reduce((a: Record<string, number>, r: any) => {
    const role = String(r?.role ?? 'unknown');
    a[role] = (a[role] || 0) + 1;
    return a;
  }, {});

  console.log('rows:', rows.length);
  console.log('roleCounts:', roleCounts);
  console.log('hasAssistant:', rows.some((r: any) => r.role === 'assistant'));
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
