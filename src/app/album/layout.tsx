// ❌ <html> や <body> は絶対に書かない
export default function AlbumLayout({ children }: { children: React.ReactNode }) {
    return (
      <main className="album-layout">
        {children}
      </main>
    );
  }
  