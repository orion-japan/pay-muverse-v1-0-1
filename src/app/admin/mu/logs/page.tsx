// src/app/admin/mu/logs/page.tsx
// Mu ログ可視化画面：意図→合意ターン数や画像生成失敗率などの簡易表示

"use client";

import React, { useEffect, useState } from "react";
import { MU_KPI } from "@/lib/mu/config";

type Metric = {
  key: string;
  label: string;
  value: string | number;
};

export default function AdminMuLogsPage() {
  const [metrics, setMetrics] = useState<Metric[]>([]);

  useEffect(() => {
    // 本来は API / DB からフェッチ
    // ここではダミーデータ
    setMetrics([
      { key: MU_KPI.INTENT_TO_AGREEMENT_TURNS_AVG, label: "意図→合意 平均ターン数", value: 1.4 },
      { key: MU_KPI.IMAGE_FAIL_RATE, label: "画像生成失敗率", value: "2%" },
      { key: MU_KPI.IMAGE_FALLBACK_RATE, label: "フォールバック発生率", value: "1%" },
      { key: MU_KPI.IMAGE_LATENCY_MS_AVG, label: "画像生成 平均時間 (ms)", value: 2800 },
      { key: MU_KPI.USER_FDBK_INTENT_UNDERSTOOD, label: "意図が伝わった率", value: "92%" },
    ]);
  }, []);

  return (
    <main style={styles.root}>
      <h1 style={styles.h1}>Mu ログ／メトリクス</h1>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>項目</th>
            <th style={styles.th}>値</th>
            <th style={styles.th}>キー</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.key}>
              <td style={styles.td}>{m.label}</td>
              <td style={styles.td}>{m.value}</td>
              <td style={styles.tdSmall}>{m.key}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    padding: 24,
    fontFamily: "sans-serif",
    color: "#e8ecff",
    background: "#0b1437",
    minHeight: "100vh",
  },
  h1: { fontSize: 20, marginBottom: 16, fontWeight: 700 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 8,
    overflow: "hidden",
  },
  th: {
    textAlign: "left",
    padding: 8,
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    fontSize: 13,
    fontWeight: 600,
  },
  td: {
    padding: 8,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    fontSize: 13,
  },
  tdSmall: {
    padding: 8,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    fontSize: 11,
    opacity: 0.7,
  },
};
