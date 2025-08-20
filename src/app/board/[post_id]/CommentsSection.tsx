'use client';

import { useEffect, useRef } from 'react';

export type Comment = {
  comment_id: string;
  created_at: string;
  content: string;
  user_code?: string | null;
};

export default function CommentsSection({
  comments,
  focusOnMount,
}: {
  comments: Comment[];
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnMount && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusOnMount]);

  return (
    <section ref={ref} style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>コメント（{comments.length}）</h2>
      {comments.length === 0 ? (
        <p style={{ color: '#666' }}>まだコメントがありません。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
          {comments.map((c) => (
            <li key={c.comment_id} style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                {new Date(c.created_at).toLocaleString()}
                {c.user_code ? ` ・ by ${c.user_code}` : ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.content}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
