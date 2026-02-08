const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log('SUPABASE_ENV_MISSING');
  process.exit(0);
}

const sb = createClient(url, key);

(async () => {
  const { data, error } = await sb
    .from('iros_memory_state')
    .select('intent_anchor,anchor_write,anchor_event,itx_step')
    .eq('user_code', '669933')
    .maybeSingle();

  if (error) {
    console.log('ERROR', error.message);
    return;
  }
  if (!data) {
    console.log('NO_ROW');
    return;
  }

  const ia = data.intent_anchor;
  const hasFixedTrue =
    ia && typeof ia === 'object' && ia.fixed === true;

  console.log(JSON.stringify({
    itx_step: data.itx_step ?? null,
    anchor_write: data.anchor_write ?? null,
    anchor_event: data.anchor_event ?? null,
    intent_anchor: ia ?? null,
    has_fixed_true: hasFixedTrue,
  }, null, 2));
})();
