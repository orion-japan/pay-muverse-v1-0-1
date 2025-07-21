// 正常なカード登録画面リダイレクト用API

import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const customerId = searchParams.get('customer');

  if (!customerId) {
    return NextResponse.json({ error: 'customer parameter is required' }, { status: 400 });
  }

  try {
    const formUrl = `https://checkout.pay.jp/customers/${customerId}/card/edit`;
    return NextResponse.redirect(formUrl);
  } catch (err) {
    return NextResponse.json({ error: 'Failed to create card form' }, { status: 500 });
  }
}
