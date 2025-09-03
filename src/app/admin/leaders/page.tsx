// src/app/admin/leaders/page.tsx
"use client";

import LeaderPanel from "./LeaderPanel";


export default function LeadersPage() {
  return (
    <main style={{ padding: "20px" }}>
      <h2>リーダー管理画面</h2>
      <LeaderPanel />
    </main>
  );
}
