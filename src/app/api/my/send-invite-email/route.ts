import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import sendgrid from '@sendgrid/mail';

// 任意: 送信元
const FROM_EMAIL = process.env.INVITE_FROM_EMAIL || 'no-reply@muverse.jp';

// Resend or SendGrid を自動判定
const hasResend = !!process.env.RESEND_API_KEY;
const hasSendgrid = !!process.env.SENDGRID_API_KEY;

if (hasSendgrid) {
  sendgrid.setApiKey(process.env.SENDGRID_API_KEY!);
}

export async function POST(req: Request) {
  try {
    const { to, link, senderName } = await req.json();
    if (!to || !link) {
      return NextResponse.json({ error: 'to and link are required' }, { status: 400 });
    }

    const subject = senderName ? `${senderName} から招待が届きました` : `Muverse 招待リンク`;

    const html = `
      <p>こんにちは。</p>
      <p>以下のリンクから登録にお進みください。</p>
      <p><a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a></p>
      <hr />
      <p>※リンクは個別のパラメータを含んでいます。他人に転送しないでください。</p>
    `;

    // 1) Resend
    if (hasResend) {
      const resend = new Resend(process.env.RESEND_API_KEY!);
      const r = await resend.emails.send({
        from: FROM_EMAIL,
        to,
        subject,
        html,
      });
      if (r.error) return NextResponse.json({ error: r.error }, { status: 500 });
      return NextResponse.json({ ok: true, provider: 'resend', id: r.data?.id });
    }

    // 2) SendGrid
    if (hasSendgrid) {
      const r = await sendgrid.send({
        to,
        from: FROM_EMAIL,
        subject,
        html,
      });
      return NextResponse.json({
        ok: true,
        provider: 'sendgrid',
        id: r[0]?.headers?.['x-message-id'],
      });
    }

    return NextResponse.json({ error: 'No email provider configured' }, { status: 500 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
