// src/app/mu-debug/page.tsx
"use client";

import React, { useState } from "react";

export default function MuDebugPage() {
  const [text, setText] = useState("明日のToDoを3つにまとめて");
  const [resp, setResp] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const send = async () => {
    setLoading(true);
    setResp(null);
    const r = await fetch("/api/mu", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
    });
    const j = await r.json();
    setResp(j);
    setLoading(false);
  };

  return (
    <main style={{ padding: 20, maxWidth: 800, margin: "0 auto", fontFamily: "sans-serif" }}>
      <h1>Mu Debug</h1>
      <textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
      />
      <div style={{ marginTop: 8 }}>
        <button onClick={send} disabled={loading} style={{ padding: "8px 12px" }}>
          {loading ? "送信中…" : "Mu に送信"}
        </button>
      </div>
      {resp && (
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: "#0b1437",
            color: "#e8ecff",
            borderRadius: 8,
            overflowX: "auto",
          }}
        >
{JSON.stringify({ ok: resp.ok, agent: resp.agent, content: resp.content, meta: resp.meta }, null, 2)}
        </pre>
      )}
    </main>
  );
}
