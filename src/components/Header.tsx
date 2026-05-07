'use client';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';

type Props = { onLoginClick: () => void };

export default function Header({ onLoginClick }: Props) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const isLoggedIn = !!user && !loading;

  const prevent = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isLoggedIn) {
      e.preventDefault();
      onLoginClick();
    }
  };

  const handleLogout = async () => {
    await logout();
    router.push('/');
  };

  // ★ 追加：再読み込み（フルリロード）
  const handleReload = () => {
    // 完全リロード（状態をすべて捨てる）
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
    // もし状態は維持してデータだけ更新したい場合は下を使用
    // router.refresh()
  };

  return (
    // 外枠：全幅・中央寄せ（背景は付けない）
    <header
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        boxShadow: '0 2px 6px rgba(0,0,0,0.08)', // ほんの少し軽く
      }}
    >
      {/* 内枠：中央430pxに背景グラデを適用（コンパクト版） */}
      <div
        style={{
          width: '100%',
          maxWidth: '430px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px', // ← 10px 16px → 6px 10px
          height: '44px', // ← 60px → 44px
          fontWeight: 'bold',
          color: 'white',
          background: 'linear-gradient(90deg, #95a0ff, #8b82f6)',
          borderRadius: '0 0 10px 10px', // ほんの少しだけ丸み（お好みで）
        }}
      >
        <Link
          href="/"
          onClick={prevent}
          style={{
            textDecoration: 'none',
            color: 'white',
            fontSize: '14px', // ← 18px → 14px
            fontWeight: 800,
            padding: '4px 8px',
            borderRadius: '8px',
            background: 'rgba(255,255,255,0.18)',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span aria-hidden>🏠</span>
        </Link>

        <div
          style={{
            fontSize: '16px', // ← 22px → 16px
            fontWeight: 900,
            textAlign: 'center',
            letterSpacing: '.3px',
            lineHeight: 1,
          }}
        >
          Muverse
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* ★ 追加：再読み込みボタン */}
          <button
            onClick={handleReload}
            aria-label="再読み込み"
            title="再読み込み"
            style={{
              height: '28px',
              padding: '0 10px',
              background: 'rgba(255,255,255,0.22)',
              border: 'none',
              borderRadius: '8px',
              color: 'white',
              fontSize: '12px',
              fontWeight: 800,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            🔄
          </button>

          {isLoggedIn ? (
            <button
              onClick={handleLogout}
              style={{
                height: '28px', // ← 34px 相当 → 28px
                padding: '0 10px',
                background: 'rgba(255,255,255,0.22)',
                border: 'none',
                borderRadius: '8px', // ← 6px → 8px（視覚的に小さく見える）
                color: 'white',
                fontSize: '12px',
                fontWeight: 800,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              ログアウト
            </button>
          ) : (
            <button
              onClick={onLoginClick}
              style={{
                height: '28px',
                padding: '0 10px',
                background: 'rgba(255,255,255,0.22)',
                border: 'none',
                borderRadius: '8px',
                color: 'white',
                fontSize: '12px',
                fontWeight: 800,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              ログイン
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
