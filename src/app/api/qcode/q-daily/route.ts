// app/api/qcode/q-daily/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const user = searchParams.get('user')!
  const days = Number(searchParams.get('days') ?? '14')
  const { data, error } = await supa.rpc('q_daily_with_carry', { p_user: user, p_days: days })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ user, days, items: data })
}
