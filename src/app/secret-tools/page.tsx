// src/app/secret-tools/page.tsx
'use client';

import Link from 'next/link';

export default function SecretToolsPage() {
  const buttons = [
    { id: 'slideshow', label: 'スライドショー', href: '/slideshow' },
    { id: 'app1', label: 'iros 開発中', href: '/iros' },
    { id: 'app2', label: 'mui 開発中', href: '/mui' },
    { id: 'test', label: 'テストページ', href: '/dev/test' },
  ];

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background:
          'linear-gradient(180deg, #f7fbff 0%, #eef5ff 40%, #ffffff 100%)',
        fontFamily: '"Zen Maru Gothic", system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          padding: '24px 20px 32px',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Link
            href="/"
            style={{
              fontSize: 14,
              textDecoration: 'none',
              color: '#777',
            }}
          >
            ← Muverse Home に戻る
          </Link>
        </div>

        <div
          style={{
            borderRadius: 24,
            padding: '18px 18px 20px',
            background: 'rgba(255,255,255,0.9)',
            boxShadow: '0 10px 30px rgba(88,130,255,0.16)',
            border: '1px solid rgba(180,195,255,0.6)',
          }}
        >
          <h1
            style={{
              fontSize: 18,
              margin: 0,
              marginBottom: 4,
            }}
          >
            🔐 Secret Lab
          </h1>
          <p
            style={{
              fontSize: 12,
              color: '#666',
              margin: 0,
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            ここは Muverse の開発者用メニューです。
            <br />
            スライドショーや開発中ツールにジャンプできます。
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginTop: 10,
            }}
          >
            {buttons.map((btn) => (
              <Link
                key={btn.id}
                href={btn.href}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '14px 10px',
                  borderRadius: 18,
                  textDecoration: 'none',
                  background: '#ffffff',
                  border: '1px solid rgba(180,195,255,0.7)',
                  boxShadow: '0 6px 18px rgba(120,150,255,0.2)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#4a5fd4',
                  textAlign: 'center',
                }}
              >
                {btn.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
