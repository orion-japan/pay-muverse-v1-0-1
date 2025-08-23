// Server Component（← "use client" は不要）
// /self 配下のページを必ず固定幅フレームに入れる
import type { ReactNode } from "react";
import "./layout.css";

export default function SelfLayout({ children }: { children: ReactNode }) {
  return (
    <div className="self-shell">
      <div className="self-frame" role="group" aria-label="Self pages">
        {children}
      </div>
    </div>
  );
}
