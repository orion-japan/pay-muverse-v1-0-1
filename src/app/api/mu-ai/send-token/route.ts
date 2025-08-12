import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  console.log('=== [SEND_TOKEN] API開始 ===');

  try {
    const { idToken } = await req.json();
    if (!idToken) {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 });
    }

    // 1. get-user-info 呼び出し
    const getUserInfoRes = await fetch(`${process.env.BASE_URL || 'http://localhost:3000'}/api/get-user-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }), // get-user-info はこの形
    });
    const getUserInfoData = await getUserInfoRes.json();

    // 2. call-mu-ai 呼び出し（相手仕様に合わせて auth.idToken）
    const callMuAiRes = await fetch(`${process.env.BASE_URL || 'http://localhost:3000'}/api/call-mu-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth: { mode: 'firebase', idToken }
      }),
    });
    const callMuAiData = await callMuAiRes.json();

    return NextResponse.json({
      status: 'ok',
      getUserInfo: getUserInfoData,
      callMuAi: callMuAiData,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
