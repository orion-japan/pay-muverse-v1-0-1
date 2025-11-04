'use client';

import Link from 'next/link';

type CTA = { label: string; href: string };
export default function MuiChatCTA({ actions }: { actions: CTA[] }) {
  if (!actions?.length) return null;
  return (
    <div
      className="mui-cta"
      style={{ margin: '6px 0 8px', display: 'flex', flexWrap: 'wrap', gap: 8 }}
    >
      {actions.map((a, i) => (
        <Link
          key={i}
          href={a.href}
          className="btn"
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #dde',
            background: '#fff',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}
