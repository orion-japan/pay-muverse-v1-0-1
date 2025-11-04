import { supabaseServer } from '@/lib/supabaseServer';
import type { Metadata } from 'next';
import ImageSlider from './ImageSlider';
import CommentForm from './CommentForm';
import CommentsSection from './CommentsSection';
import Link from 'next/link'; // ★ 追加

import './post.css';

type Params = { post_id: string };
type SearchParams = { [k: string]: string | string[] | undefined };

// 🟢 修正済み: params を Promise で受けて await
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { post_id } = await params;

  const { data } = await supabaseServer
    .from('posts')
    .select('title, content')
    .eq('post_id', post_id)
    .eq('visibility', 'public')
    .single();

  const title = data?.title || 'Iボードの投稿';
  const desc = (data?.content || '').slice(0, 80);

  return {
    title,
    description: desc,
    openGraph: {
      title,
      description: desc,
      images: [{ url: `/board/${post_id}/opengraph-image` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: desc,
      images: [`/board/${post_id}/opengraph-image`],
    },
  };
}

// 🟢 修正済み: params / searchParams を Promise で受けて await
export default async function BoardPostPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const { post_id } = await params;
  const sp = await searchParams;

  // 投稿本体
  const { data: post } = await supabaseServer
    .from('posts')
    .select('*')
    .eq('post_id', post_id)
    .eq('visibility', 'public')
    .single();

  if (!post) return <main style={{ padding: 16 }}>投稿が見つかりませんでした。</main>;

  // 🟣 コメント一覧（テーブル名と列に合わせる）
  const { data: comments } = await supabaseServer
    .from('post_comments')
    .select('comment_id, post_id, user_code, content, created_at')
    .eq('post_id', post_id)
    .order('created_at', { ascending: true });

  const imgs: string[] = Array.isArray(post.media_urls)
    ? post.media_urls.map((u: any) => (typeof u === 'string' ? u : u?.url)).filter(Boolean)
    : [];

  const likes = post.likes_count ?? post.q_code?.resonance?.likes ?? 0;
  const coms = post.comments_count ?? post.q_code?.resonance?.comments ?? comments?.length ?? 0;

  const wantFocusComments = sp?.focus === 'comments';

  return (
    <main style={{ maxWidth: 840, margin: '0 auto', padding: 16 }}>
      {/* 🟢 戻るボタン（Linkに変更） */}
      <div style={{ marginBottom: 12 }}>
        <Link href="/board" className="back-link" style={{ fontSize: 14, color: '#555' }}>
          ← Iボードに戻る
        </Link>
      </div>

      <article>
        <h1 style={{ marginBottom: 6 }}>{post.title || '（無題）'}</h1>
        <div style={{ color: '#666', display: 'flex', gap: 12, marginBottom: 12 }}>
          <span>📅 {new Date(post.created_at).toLocaleString()}</span>
          <span>❤️ {likes}</span>
          <span>💬 {coms}</span>
        </div>

        {imgs.length > 0 && <ImageSlider urls={imgs} />}

        {post.content && <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{post.content}</p>}

        {post.tags && post.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {post.tags.map((tag: string, i: number) => (
              <span
                key={i}
                style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  border: '1px solid #eee',
                  borderRadius: 12,
                }}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </article>

      {/* コメント一覧＋スクロール制御（client） */}
      <CommentsSection
        comments={(comments || []) as any[]}
        focusOnMount={wantFocusComments === true}
      />

      {/* コメント投稿フォーム（client） */}
      <CommentForm postId={post_id} />

      {/* 末尾アンカー（送信後スクロール用） */}
      <div id="comments-bottom" style={{ height: 4 }} />
    </main>
  );
}
