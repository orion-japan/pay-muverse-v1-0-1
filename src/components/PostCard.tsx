'use client';

import './PostCard.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  media_urls: string[];
  created_at: string;
  click_username?: string;
  avatar_url?: string;
  visibility?: string;
  likes_count?: number;
  comments_count?: number;
};

type PostCardProps = {
  post: Post;
};

export default function PostCard({ post }: PostCardProps) {
  return (
    <div className="post-card">
      <div className="post-header">
        <img
          src={post.avatar_url || '/default-avatar.png'}
          alt="avatar"
          className="avatar"
        />
        <div className="username-date">
          <div className="username">{post.click_username || 'Unknown'}</div>
          <div className="date">{new Date(post.created_at).toLocaleString()}</div>
        </div>
      </div>

      <div className="post-body">
        {post.title && <h2 className="post-title">{post.title}</h2>}
        {post.content && <p className="post-content">{post.content}</p>}
        {post.media_urls?.length > 0 && (
          <div className="image-wrapper">
            <img
              src={post.media_urls[0]}
              alt="投稿画像"
              className="post-image"
            />
          </div>
        )}
        {post.tags?.length > 0 && (
          <div className="tag-list">
            {post.tags.map((tag, index) => (
              <span key={index} className="tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="post-footer">
        <div className="badge">{post.category || '未分類'}</div>
        <div className="meta">
          ❤️ {post.likes_count ?? 0}　💬 {post.comments_count ?? 0}
        </div>
      </div>
    </div>
  );
}
