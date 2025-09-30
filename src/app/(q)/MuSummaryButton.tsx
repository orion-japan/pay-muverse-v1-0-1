"use client";
import Link from "next/link";
import { useMemo } from "react";

export function MuSummaryButton({ userCode, days = 30 }: { userCode: string; days?: number }) {
  const href = useMemo(() => {
    const p = new URLSearchParams({ user: userCode, days: String(days), scope: "qcode" });
    return `/api/mu/summary?${p.toString()}`;
  }, [userCode, days]);

  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-xl px-4 py-2 shadow-md hover:shadow-lg transition"
      title="直近のQから総評を作成して会話を開始"
      prefetch={false}
    >
      🪔 Mu AI 総評（{days}日）
    </Link>
  );
}
