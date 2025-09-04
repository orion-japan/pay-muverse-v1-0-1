// src/app/api/create-invite/route.ts
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { randomBytes } from 'crypto'

export async function POST(req: Request) {
  const { user_code, group_code, max_uses, expires_at } = await req.json()

  const code = "INV-" + randomBytes(3).toString("hex").toUpperCase()

  const { error } = await supabaseAdmin.from("invite_codes").insert({
    code,
    issuer_code: user_code,
    group_code,
    max_uses: max_uses ?? 1,
    expires_at: expires_at ?? null
  })

  if (error) return NextResponse.json({ error }, { status: 500 })

  return NextResponse.json({ code })
}
