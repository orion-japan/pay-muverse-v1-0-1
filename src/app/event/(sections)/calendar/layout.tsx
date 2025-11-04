// src/app/event/(sections)/calendar/layout.tsx
export const dynamic = 'force-dynamic';
export const revalidate = 0; // ← ここに移す（数値 or false）
export const runtime = 'nodejs'; // 任意。SSRで安定させたい場合

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
