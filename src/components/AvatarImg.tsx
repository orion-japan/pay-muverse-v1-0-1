// src/components/AvatarImg.tsx
'use client';

import React from 'react';

type Props = {
  /** DBに保存された値（例: "669933/xxx.webp" / "avatars/669933/xxx.webp" / フルURL / dataURL） */
  src?: string | null;
  alt: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** キャッシュバスター用（userId などを渡すと v=xxx が付きます） */
  versionKey?: string | number;
};

/** Supabase ベースURL（末尾のスラッシュ除去） */
const SUPABASE_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
/** アバター用バケット名（環境変数で差し替え可能） */
const AVATAR_BUCKET = process.env.NEXT_PUBLIC_AVATAR_BUCKET || 'avatars';

/** 任意の文字列を “公開URL” に解決する */
function resolveAvatarUrl(raw?: string | null): string {
  const u = (raw ?? '').trim();
  if (!u) return '/avatar.png';

  // すでにフルURL or data URL
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;

  // Supabase の /storage/v1/object/public/... 相対
  if (u.startsWith('/storage/')) return `${SUPABASE_BASE}${u}`;

  // すでに "avatars/..." 等のバケット名付きキー
  if (u.startsWith(`${AVATAR_BUCKET}/`)) {
    return `${SUPABASE_BASE}/storage/v1/object/public/${u}`;
  }

  // キーだけ（例: "669933/xxx.webp"）
  const key = u.replace(/^\/+/, ''); // 念のため先頭スラッシュ除去
  return `${SUPABASE_BASE}/storage/v1/object/public/${AVATAR_BUCKET}/${key}`;
}

const AvatarImg: React.FC<Props> = ({ src, alt, size = 32, className, style, versionKey }) => {
  // 初期URLを解決
  const initialUrl = React.useMemo(() => {
    const base = resolveAvatarUrl(src);
    return versionKey ? `${base}${base.includes('?') ? '&' : '?'}v=${versionKey}` : base;
  }, [src, versionKey]);

  const [url, setUrl] = React.useState(initialUrl);

  // src が変わったら更新
  React.useEffect(() => {
    setUrl(initialUrl);
  }, [initialUrl]);

  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        display: 'block',
        ...style,
      }}
      onError={() => {
        // 404/読み込み失敗時はデフォルトへ
        if (url !== '/avatar.png') setUrl('/avatar.png');
      }}
    />
  );
};

export default AvatarImg;
