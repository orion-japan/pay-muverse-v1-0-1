// src/components/AdminGate.tsx
'use client';
export default function AdminGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>; // ← 何もチェックしない（暫定）
}
