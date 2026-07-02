// src/app/admin/page.tsx
import Link from 'next/link';

const cards = [
  {
    title: '招待リンク発行',
    href: '/admin/invites',
    desc: 'MuBook拡散用の短縮URL・QR・SNS別リンクを発行します。',
    status: 'MVP',
  },
  {
    title: 'イベント招待',
    href: '/admin/events',
    desc: '既存のグループ作成・イベント用招待コード発行画面です。',
    status: '稼働中',
  },
  {
    title: '登録ログ',
    href: '/admin/register-logs',
    desc: '登録時のIP・電話番号・紹介コードを確認します。',
    status: '稼働中',
  },
  {
    title: 'クレジット管理',
    href: '/admin/credits',
    desc: 'ユーザーのクレジット残高・付与・履歴を確認します。',
    status: '稼働中',
  },
  {
    title: 'Mautic同期',
    href: '/admin/mautic/sync',
    desc: 'Mautic同期ログ・最終同期・エラー確認用。次フェーズで実装します。',
    status: '準備中',
  },
  {
    title: 'MuBook分析',
    href: '/admin/mubook',
    desc: 'guest_id・読了率・音声再生・登録転換を確認します。次フェーズで実装します。',
    status: '準備中',
  },
  {
    title: 'リアルタイム来訪',
    href: '/admin/live',
    desc: '今読んでいるゲスト・ユーザーを確認し、Mu通知につなげます。',
    status: '準備中',
  },
  {
    title: 'マーケティング分析',
    href: '/admin/marketing',
    desc: '媒体別流入・登録率・ステップメール成果を確認します。',
    status: '準備中',
  },
];

export default function AdminHomePage() {
  return (
    <main style={styles.page}>
      <section style={styles.hero}>
        <div>
          <p style={styles.kicker}>Muverse Admin</p>
          <h1 style={styles.title}>運営管理</h1>
          <p style={styles.lead}>
            招待・ユーザー・MuBook・Mautic・マーケティングをここに集約します。
          </p>
        </div>
        <Link href="/admin/invites" style={styles.primaryButton}>
          招待リンクを発行
        </Link>
      </section>

      <section style={styles.grid}>
        {cards.map((card) => {
          const ready = card.status !== '準備中';
          return (
            <Link
              key={card.href}
              href={card.href}
              style={{ ...styles.card, opacity: ready ? 1 : 0.72 }}
            >
              <div style={styles.cardHead}>
                <h2 style={styles.cardTitle}>{card.title}</h2>
                <span style={{ ...styles.badge, ...(ready ? styles.badgeReady : styles.badgePending) }}>
                  {card.status}
                </span>
              </div>
              <p style={styles.cardDesc}>{card.desc}</p>
            </Link>
          );
        })}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #f7f3ff 0%, #ffffff 45%, #f7fbff 100%)',
    padding: '28px 18px 60px',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#1f2937',
  },
  hero: {
    maxWidth: 1040,
    margin: '0 auto 22px',
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    background: 'rgba(255,255,255,0.82)',
    border: '1px solid rgba(124,58,237,0.14)',
    borderRadius: 24,
    padding: 22,
    boxShadow: '0 16px 50px rgba(88, 28, 135, 0.08)',
    flexWrap: 'wrap',
  },
  kicker: { margin: 0, color: '#7c3aed', fontWeight: 700, letterSpacing: '.04em' },
  title: { margin: '4px 0 8px', fontSize: 30, lineHeight: 1.2 },
  lead: { margin: 0, color: '#6b7280', lineHeight: 1.8 },
  primaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '0 18px',
    borderRadius: 999,
    background: '#7c3aed',
    color: '#fff',
    textDecoration: 'none',
    fontWeight: 700,
    boxShadow: '0 10px 28px rgba(124,58,237,0.25)',
  },
  grid: {
    maxWidth: 1040,
    margin: '0 auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 14,
  },
  card: {
    display: 'block',
    padding: 18,
    borderRadius: 20,
    background: 'rgba(255,255,255,0.9)',
    border: '1px solid rgba(17,24,39,0.08)',
    textDecoration: 'none',
    color: 'inherit',
    boxShadow: '0 10px 30px rgba(15,23,42,0.05)',
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  cardTitle: { margin: 0, fontSize: 17 },
  cardDesc: { margin: '10px 0 0', color: '#6b7280', lineHeight: 1.7, fontSize: 14 },
  badge: { fontSize: 12, borderRadius: 999, padding: '4px 9px', whiteSpace: 'nowrap' },
  badgeReady: { background: '#ecfdf5', color: '#047857' },
  badgePending: { background: '#f3f4f6', color: '#6b7280' },
};
