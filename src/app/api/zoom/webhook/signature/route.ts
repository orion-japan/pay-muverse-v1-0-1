import { NextResponse } from 'next/server'
import crypto from 'crypto'

const SDK_KEY = process.env.ZOOM_SDK_KEY!
const SDK_SECRET = process.env.ZOOM_SDK_SECRET!

export async function POST(req: Request) {
  try {
    const { meetingNumber, role = 0 } = await req.json()
    if (!SDK_KEY || !SDK_SECRET) throw new Error('SDK key/secret not set')
    if (!meetingNumber) throw new Error('meetingNumber required')

    // Zoom Web SDK Signature
    const iat = Date.now() - 30000
    const msg = Buffer.from(`${SDK_KEY}${meetingNumber}${iat}${role}`).toString('base64')
    const hash = crypto.createHmac('sha256', SDK_SECRET).update(msg).digest('base64')
    const signature = Buffer.from(`${SDK_KEY}.${meetingNumber}.${iat}.${role}.${hash}`).toString('base64')

    return NextResponse.json({ signature, sdkKey: SDK_KEY })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 400 })
  }
}
