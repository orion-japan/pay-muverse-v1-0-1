// lib/email/sendVerification.ts

import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port: Number(process.env.EMAIL_SMTP_PORT),
  secure: true, // 465 を使う場合 true
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS,
  },
  tls: {
    // ✅ 自己署名証明書に対応（← ここが今回のポイント）
    rejectUnauthorized: false,
  },
});

export async function sendVerificationEmail(to: string, link: string) {
  await transporter.sendMail({
    from: process.env.EMAIL_SENDER_ADDRESS,
    to,
    subject: '【Muverse】メールアドレスの確認',
    html: `
      <p>以下のリンクをクリックしてメールアドレスの確認を完了してください：</p>
      <p><a href="${link}">${link}</a></p>
    `,
  });
}
