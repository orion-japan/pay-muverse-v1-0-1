// src/app/admin/mu/page.tsx
// Mu 管理画面：現在のシステムプロンプトや設定値の確認用
// docs/mu-agent.md へのリンクを追加

"use client";

import React, { useMemo } from "react";
import {
  MU_AGENT,
  MU_CONFIG_VERSION,
  MU_CREDITS,
  MU_IMAGE,
} from "@/lib/mu/config";
import { buildMuSystemPrompt } from "@/lib/mu/buildSystemPrompt";

export default function AdminMuPage() {
  const systemPrompt = useMemo(() => buildMuSystemPrompt(), []);

  return (
    <main style={styles.root}>
      <h1 style={styles.h1}>Mu 管理画面</h1>

      <section style={styles.section}>
        <h2 style={styles.h2}>エージェント情報</h2>
        <ul>
          <li>ID: {MU_AGENT.ID}</li>
          <li>Title: {MU_AGENT.TITLE}</li>
          <li>Version: {MU_AGENT.VERSION}</li>
          <li>Config Version: {MU_CONFIG_VERSION}</li>
        </ul>
        <div style={styles.docLink}>
          <a
            href="/docs/mu-agent.md"
            target="_blank"
            rel="noreferrer"
            style={styles.link}
          >
            📄 Mu 運用ガイド（docs/mu-agent.md）
          </a>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>クレジット設定</h2>
        <ul>
          <li>テキスト1往復: {MU_CREDITS.TEXT_PER_TURN} クレジット</li>
          <li>画像生成: {MU_CREDITS.IMAGE_PER_GEN} クレジット</li>
        </ul>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>画像生成設定</h2>
        <ul>
          <li>既定サイズ: {MU_IMAGE.DEFAULT_SIZE}</li>
          <li>モデル: {MU_IMAGE.MODEL_PRIMARY}</li>
          <li>フォールバック: {MU_IMAGE.MODEL_FALLBACK}</li>
          <li>API パス: {MU_IMAGE.API_PATH}</li>
        </ul>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>現在のシステムプロンプト</h2>
        <pre style={styles.pre}>{systemPrompt}</pre>
      </section>
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
  h1: { fontSize: 22, marginBottom: 16, fontWeight: 700 },
  h2: { fontSize: 16, marginTop: 20, marginBottom: 8, fontWeight: 600 },
  section: {
    marginBottom: 24,
    padding: 16,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.04)",
  },
  pre: {
    whiteSpace: "pre-wrap",
    background: "rgba(0,0,0,0.4)",
    padding: 12,
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.6,
    overflowX: "auto",
  },
  docLink: { marginTop: 8 },
  link: {
    fontSize: 13,
    color: "#9ecbff",
    textDecoration: "underline",
  },
};
