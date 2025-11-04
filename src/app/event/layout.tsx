export default function EventLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="km-root">
      <header style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Event</h1>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <a href="/event" className="km-link">
            カレンダー
          </a>
          <a href="/event/kyomeikai" className="km-link">
            共鳴会
          </a>
          <a href="/event/meditation" className="km-link">
            瞑想
          </a>
          <a href="/event/live" className="km-link">
            LIVE
          </a>
        </nav>
      </header>
      <main style={{ padding: 12 }}>{children}</main>
    </div>
  );
}
