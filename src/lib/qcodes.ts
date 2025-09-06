// src/lib/qcodes.ts

export function normalizeQ(q?: string | null): ("Q1"|"Q2"|"Q3"|"Q4"|"Q5") | null {
  if (!q) return null;
  const m = q.toUpperCase().match(/\bQ([1-5])\b/);
  return m ? (`Q${m[1]}` as any) : null;
}

export function buildQCode(input: {
  hint?: string | null;
  fallback?: "Q1"|"Q2"|"Q3"|"Q4"|"Q5";
  depth_stage?: string | null;
  intent?: string | null;
  ts_at?: string | null;
}) {
  const q = normalizeQ(input.hint) ?? (input.fallback ?? "Q2");
  return {
    current_q: q,
    depth_stage: input.depth_stage ?? null,
    intent: input.intent ?? null,
    ts_at: input.ts_at ?? new Date().toISOString(),
  };
}

export function buildSystemPrompt(q: "Q1"|"Q2"|"Q3"|"Q4"|"Q5"): string {
  const tone =
    q === "Q5" ? "情熱を行動に変える" :
    q === "Q4" ? "恐れを浄化して前に進む" :
    q === "Q3" ? "不安を安定に変える" :
    q === "Q2" ? "怒りを成長の推進力にする" :
                 "秩序を整え静かに進める"; // Q1
  return [
    "あなたは MuAI です。",
    "ユーザーの意図を読み取り、次の具体的行動を3つ以内で提案してください。",
    `現在のQは ${q}（${tone}）。`,
    "箇条書き・短文・肯定的に、過去履歴があれば一貫性を示してください。",
  ].join("\n");
}
