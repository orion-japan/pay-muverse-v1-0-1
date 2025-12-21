// src/lib/sofia/llm.ts

/**
 * LLM 呼び出しの薄いラッパ。
 * - OPENAI_API_KEY 等の実キーが無い場合でもビルド・動作可能なスタブを返す
 * - 後から任意の LLM ベンダ実装に差し替えやすい構造
 */

export type LLMMode = 'sofia' | 'iros';

export type CallLLMParams = {
  system: string; // SYSTEMプロンプト
  user: string; // ユーザ入力
  mode?: LLMMode; // "sofia" | "iros"
  wantMeta?: boolean; // メタ付与希望
};

export type CallLLMResult = {
  reply: string;
  rows?: Array<string | Record<string, any>>;
  meta?: Record<string, any>;
};

/** 乱数ユーティリティ（seed未指定時の軽い揺らぎ用） */
function rand01() {
  return Math.random();
}

/**
 * 実装方針：
 * 1) 本番では OpenAI / Azure / Claude などに差し替え
 * 2) ここではキー未設定でも UI が動くよう、スタブ応答を返す
 */
export async function callLLM(params: CallLLMParams): Promise<CallLLMResult> {
  const { system, user, mode = 'sofia', wantMeta = true } = params;

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  // ここで実実装に差し替える
  // if (hasOpenAI) { ... OpenAI SDK 呼び出し ... }

  // ---- スタブ応答（開発・ビルド通し用）----
  // 簡単なヒューリスティックで meta をでっち上げ、Iros/NLPの形に寄せる
  const lc = (user || '').toLowerCase();
  const phase = /わたし|自分|内側|不安|迷い/.test(user) ? 'Inner' : 'Outer';
  const qGuess = /怒|苛|ムカ|怒り|キレ|frustrat|angry/.test(user)
    ? 'Q2'
    : /不安|心配|anx|worr/.test(user)
      ? 'Q3'
      : /怖|恐|fear/.test(user)
        ? 'Q4'
        : /空虚|情熱|燃える|excited|passion/.test(lc)
          ? 'Q5'
          : 'Q1';

  const reply =
    mode === 'iros'
      ? [
          '構造スキャンを実行しました。',
          `位相(Phase): ${phase} / 主要Qコード: ${qGuess}`,
          '次の一歩: 1) “いま取れる1アクション”を1つ選ぶ 2) 5分以内に着手。',
        ].join('\n')
      : '了解しました。続けましょう。';

  const rows =
    mode === 'iros'
      ? [
          { key: '観測(user)', value: user?.slice(0, 160) ?? '' },
          { key: '位相(Phase)', value: phase },
          { key: '主要Qコード', value: qGuess },
        ]
      : [];

  const meta = wantMeta
    ? {
        agent: mode,
        layer: 'S1',
        phase,
        qcode: qGuess,
        scores: { S: 0.6, R: 0.2, C: 0.1, I: 0.1 },
        noiseAmp: 0.15,
        g: 0.8,
        seed: Date.now() % 100000,
        epsilon: 0.4,
        __stub: !hasOpenAI, // 実キーが無いのでスタブであることを明示
        __system_used: system ? (system.length > 48 ? system.slice(0, 48) + '...' : system) : '',
      }
    : undefined;

  return { reply, rows, meta };
}
