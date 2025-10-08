import { NextRequest, NextResponse } from "next/server";

export async function GET(_: NextRequest, { params }: { params: { seed: string } }) {
  const seed = params.seed;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE!; // server側なのでserviceでOK
  const res = await fetch(`${url}/rest/v1/v_q_case_quartet?seed_id=eq.${encodeURIComponent(seed)}`, {
    headers: { "apikey": key, "Authorization": `Bearer ${key}` },
    cache: "no-store"
  });
  const data = await res.json();
  return NextResponse.json({ ok:true, quartet: data?.[0] ?? null });
}
