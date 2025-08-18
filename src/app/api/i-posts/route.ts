import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// Qコード卵の型
type QCodeSeed = {
  status: string;
  author: {
    user_code: string;
    click_username?: string | null;
    avatar_url?: string | null;
  };
  title?: string | null;
  tags?: string[] | null;
  category?: string | null;
  keywords: string[];
  created_at: string;
  resonance: {
    likes: number;
    comments: number;
    shares: number;
    direct_reactions: number;
    indirect_reach: number;
    spread_score: number;
  };
  habit: {
    is_daily: boolean;
    streak_count: number;
    last_posted_at: string | null;
  };
};

// 投稿データの型
type PostInsert = {
  user_code: string;
  title?: string | null;
  content?: string | null;
  category?: string | null;
  tags?: string[] | null;
  media_urls: string[];
  visibility?: 'public' | 'private';
  board_type: string | null;
  is_posted?: boolean;
};

// 簡易キーワード抽出
function extractKeywords(text: string): string[] {
  if (!text) return [];
  const stopwords = ['する', 'ある', 'いる', 'こと', 'これ', 'それ', 'ため', 'よう'];
  return text
    .replace(/[。、・！!？?（）()【】「」『』\[\]]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopwords.includes(w))
    .slice(0, 5);
}

// Supabase admin client
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

/* ---------------------- GET ---------------------- */
export async function GET(req: NextRequest) {
  console.log('========== [i-posts] GET 開始 ==========');
  try {
    const { searchParams } = new URL(req.url);
    const userCode = searchParams.get('userCode');
    const boardType = searchParams.get('boardType') ?? 'i';
    const mode = searchParams.get('mode') ?? 'create'; 
    // ✅ `mode=create` → MyPage用（private）
    // ✅ `mode=board` → Board用（public）

    if (mode === 'create' && !userCode) {
      return NextResponse.json({ error: 'userCode が必要です' }, { status: 400 });
    }

    let query = admin.from('posts').select('*').eq('board_type', boardType).eq('is_posted', true);

    if (mode === 'create') {
      // Createページ: 自分の private 投稿
      query = query.eq('user_code', userCode).eq('visibility', 'private');
    } else if (mode === 'board') {
      // Boardページ: 公開投稿だけ
      query = query.eq('visibility', 'public');
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('[❌ supabase select エラー]', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[✅ 取得成功 mode=${mode}]`, data?.length ?? 0);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[❌ 予期せぬエラー]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/* ---------------------- POST ---------------------- */
export async function POST(req: NextRequest) {
  console.log('========== [i-posts] POST 開始 ==========');
  try {
    const body: PostInsert = await req.json();

    if (!body.user_code) {
      return NextResponse.json({ error: 'user_code が必要です' }, { status: 400 });
    }

    // profile 情報
    const { data: profile } = await admin
      .from('profiles')
      .select('avatar_url')
      .eq('user_code', body.user_code)
      .single();

    const { data: user } = await admin
      .from('users')
      .select('click_username')
      .eq('user_code', body.user_code)
      .single();

    // Qコード卵
    const qCodeSeed: QCodeSeed = {
      status: "pending",
      author: {
        user_code: body.user_code,
        click_username: user?.click_username ?? null,
        avatar_url: profile?.avatar_url ?? null,
      },
      title: body.title ?? null,
      tags: body.tags ?? [],
      category: body.category ?? null,
      keywords: extractKeywords(body.content ?? ""),
      created_at: new Date().toISOString(),
      resonance: {
        likes: 0,
        comments: 0,
        shares: 0,
        direct_reactions: 0,
        indirect_reach: 0,
        spread_score: 0.0,
      },
      habit: {
        is_daily: false,
        streak_count: 0,
        last_posted_at: null,
      }
    };

    // insert
    const insertData = {
      ...body,
      board_type: 'i',
      is_posted: true,
      q_code: qCodeSeed,
    };

    const { data, error } = await admin.from('posts').insert(insertData).select();

    if (error) {
      console.error('[❌ supabase insert エラー]', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[✅ 投稿成功]', data);
    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error('[❌ 予期せぬエラー]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
