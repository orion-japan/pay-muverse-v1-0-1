// src/app/api/resend-verification/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import nodemailer from 'nodemailer'

export async function POST(req: NextRequest) {
  try {
    // Authorization ヘッダーからトークン取得
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '')

    if (!token) {
      return NextResponse.json({ error: 'トークンがありません' }, { status: 401 })
    }

    // Firebaseトークン検証
    let decoded
    try {
      decoded = await adminAuth.verifyIdToken(token)
    } catch (verifyErr) {
      console.error('❌ Firebaseトークン検証失敗:', verifyErr)
      return NextResponse.json({ error: '無効なトークンです' }, { status: 403 })
    }

    const email = decoded.email
    if (!email) {
      return NextResponse.json({ error: 'メールアドレスが取得できません' }, { status: 400 })
    }

    let link: string

    try {
      // 🔗 メール認証リンク生成（有効期限つき）
      link = await adminAuth.generateEmailVerificationLink(email, {
        url:
          process.env.NEXT_PUBLIC_EMAIL_VERIFY_REDIRECT_URL ||
          `https://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}/verify`,
        handleCodeInApp: true,
      })
    } catch (genErr: any) {
      console.error('⚠️ メールリンク生成エラー:', genErr)

      // Firebaseのレート制限・既送信エラーは成功扱いにする
      if (
        genErr?.code === 'auth/too-many-requests' ||
        genErr?.message?.includes('TOO_MANY_ATTEMPTS_TRY_LATER')
      ) {
        return NextResponse.json({
          success: true,
          message: '確認メールはすでに送信済みです。メールをご確認ください。',
        })
      }

      return NextResponse.json({ error: 'メールリンク生成に失敗しました' }, { status: 500 })
    }

    // ✉️ メール送信設定
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: parseInt(process.env.EMAIL_SMTP_PORT || '465', 10),
      secure: true,
      auth: {
        user: process.env.EMAIL_SMTP_USER,
        pass: process.env.EMAIL_SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    })

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_SENDER_ADDRESS,
        to: email,
        subject: '【Muverse】メールアドレス確認のお願い',
        html: `
          <p>以下のリンクをクリックして、<br />メールアドレスを確認してください。</p>
          <p><a href="${link}">${link}</a></p>
          <p>このリンクは一定時間後に無効になります。</p>
        `,
      })
    } catch (mailErr) {
      console.error('⚠️ メール送信エラー:', mailErr)

      // メール送信でエラーが出ても、リンクが生成されていれば成功扱い
      return NextResponse.json({
        success: true,
        message: '確認メールは送信済み、またはすでに送信されています。メールをご確認ください。',
      })
    }

    return NextResponse.json({ success: true, message: '確認メールを送信しました' })
  } catch (err) {
    console.error('❌ 確認メール送信エラー:', err)
    return NextResponse.json({ error: '確認メールの送信に失敗しました' }, { status: 500 })
  }
}
