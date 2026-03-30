import nodemailer from 'nodemailer';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { email, user_id, created_at } = body;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Muverse通知" <${process.env.GMAIL_USER}>`,
      to: 'muverse.jp@gmail.com',
      subject: '【新規登録】ユーザーが登録されました',
      html: `
        <h2>新規ユーザー登録</h2>
        <p><b>Email:</b> ${email}</p>
        <p><b>User ID:</b> ${user_id}</p>
        <p><b>Created:</b> ${created_at}</p>
      `,
    });

    return Response.json({ ok: true });
  } catch (e) {
    console.error('notify error', e);
    return Response.json({ ok: false }, { status: 500 });
  }
}
