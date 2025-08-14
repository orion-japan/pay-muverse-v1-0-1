import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // DBカラムに合わせて変換（配列型は配列に）
    const payload = {
      user_code: body.user_code,
      avatar_url: body.avatar_url || null,
      birthday: body.birthday || null,
      prefecture: body.prefecture || null,
      city: body.city || null,
      x_handle: body.x_handle || null,
      instagram: body.instagram || null,
      facebook: body.facebook || null,
      linkedin: body.linkedin || null,
      youtube: body.youtube || null,
      website_url: body.website_url || null,
      interests: Array.isArray(body.interests) ? body.interests : (body.interests ? [body.interests] : null),
      skills: Array.isArray(body.skills) ? body.skills : (body.skills ? [body.skills] : null),
      activity_area: Array.isArray(body.activity_area) ? body.activity_area : (body.activity_area ? [body.activity_area] : null),
      languages: Array.isArray(body.languages) ? body.languages : (body.languages ? [body.languages] : null)
    };

    console.log('[create-profile] 挿入データ:', payload);

    const { data, error } = await supabaseServer
      .from('profiles')
      .insert([payload]);

    if (error) {
      console.error('[create-profile] DBエラー:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    console.error('[create-profile] 例外発生:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
