// ✅ layout.tsx
import './globals.css';

export const metadata = {
  title: '量子成功論 × Sofia',
  description: 'わたしはもうひとつのわたしを起動する',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body className="bg-gradient-to-b from-indigo-900 via-purple-800 to-blue-700 text-white">
        {children}
      </body>
    </html>
  );
}