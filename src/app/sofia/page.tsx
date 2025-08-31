// src/app/sofia/page.tsx
import SofiaChat from '@/components/SofiaChat/SofiaChat';

export const dynamic = 'force-dynamic';

export default function SofiaPage() {
  return (
    <main style={styles.main}>
      <div style={styles.wrap}>
        <SofiaChat />
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    width: '100%',
    minHeight: 'calc(100vh - 60px)',
    background: '#f7f8fb',
  },
  wrap: {
    maxWidth: 1200,
    margin: '0 auto',
    padding: '8px 8px 120px',
  },
};
