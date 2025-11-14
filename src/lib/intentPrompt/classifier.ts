// src/lib/intentPrompt/classifier.ts
// 目的：フォーム内容から Qコード（Q1〜Q5, IN/OUT）と Tコード（T1〜T5）を推定する。
// 方針：キーワード + 心の状態(mood) によるスコアリング。外部ライブラリは使わない。

export type Mood = '静けさ' | '希望' | '情熱' | '不安' | '迷い' | '感謝';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type TCode = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export type Phase = 'inner' | 'outer';

export type QDistribution = Record<QCode, number>;

export type IntentionClassification = {
  /** 代表となるQコード（最大スコア） */
  qCode: QCode;
  /** 5本すべてのQコードの正規化分布（0〜1, 合計≈1） */
  qDistribution: QDistribution;
  /** IN / OUT */
  phase: Phase;
  /** T層コード */
  tCode: TCode;
  /** 全体のざっくり信頼度（0〜1） */
  confidence: number;
  /** デバッグ用ログ */
  debugNotes: string[];
};

/**
 * フォーム側では name / target / line1 / line2 / line3 などを結合して渡してください。
 * 例：
 *   const text = [target, wish1, wish2, wish3].join('\n');
 *   const result = classifyIntention({ mood: form.mood, text });
 */
export function classifyIntention(input: { mood: Mood; text: string }): IntentionClassification {
  const text = (input.text || '').toLowerCase(); // 英字も一応小文字化
  const mood = input.mood;

  const debug: string[] = [];

  // -----------------------------
  // 1. Qコードのスコアリング
  // -----------------------------
  const qScores: Record<QCode, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
    Q5: 0,
  };

  // mood ベースの初期値
  switch (mood) {
    case '静けさ':
      qScores.Q4 += 2; // 水・静けさ
      qScores.Q3 += 0.5;
      debug.push('mood:静けさ → Q4 を優先');
      break;
    case '希望':
      qScores.Q2 += 2; // 成長・木
      qScores.Q5 += 0.5;
      debug.push('mood:希望 → Q2 を優先');
      break;
    case '情熱':
      qScores.Q5 += 2; // 火
      debug.push('mood:情熱 → Q5 を優先');
      break;
    case '不安':
      qScores.Q3 += 2; // 土（不安）
      qScores.Q4 += 0.5;
      debug.push('mood:不安 → Q3 を優先');
      break;
    case '迷い':
      qScores.Q1 += 1.5; // 秩序・決めきれなさ
      qScores.Q3 += 1;
      debug.push('mood:迷い → Q1/Q3 を少し上げる');
      break;
    case '感謝':
      qScores.Q2 += 1.5;
      qScores.Q4 += 1;
      debug.push('mood:感謝 → Q2/Q4 を優先');
      break;
  }

  // キーワードマップ
  type QKey = { patterns: string[]; q: QCode; weight: number; note: string };

  const qKeywords: QKey[] = [
    {
      q: 'Q1',
      weight: 1.5,
      note: 'Q1(秩序・緊張)ワード',
      patterns: [
        '我慢',
        '抑え',
        '抑える',
        '責任',
        '評価',
        '秩序',
        '制限',
        '制約',
        '締め付け',
        'ルール',
        'きちんと',
        'ちゃんと',
      ],
    },
    {
      q: 'Q2',
      weight: 1.5,
      note: 'Q2(成長・再生)ワード',
      patterns: [
        '成長',
        '伸び',
        '伸ばす',
        '挑戦',
        'チャレンジ',
        '変化',
        '変わる',
        '広がる',
        '芽生え',
        '生まれ',
        '始め',
        '飛び立',
      ],
    },
    {
      q: 'Q3',
      weight: 1.5,
      note: 'Q3(不安・安定)ワード',
      patterns: [
        '不安',
        '心配',
        '怖い',
        '安定',
        '安心',
        '土台',
        '生活',
        'お金',
        '仕事',
        '守る',
        '支える',
        '止まっている',
        '停滞',
      ],
    },
    {
      q: 'Q4',
      weight: 1.5,
      note: 'Q4(恐れ・浄化)ワード',
      patterns: [
        '浄化',
        '癒やし',
        '癒し',
        '涙',
        '悲しみ',
        'トラウマ',
        '流す',
        '洗い流す',
        '手放す',
        '赦す',
        '許す',
        '怖れ',
      ],
    },
    {
      q: 'Q5',
      weight: 1.5,
      note: 'Q5(情熱・火)ワード',
      patterns: [
        '情熱',
        '燃え',
        '炎',
        '火',
        '輝き',
        '輝く',
        '光',
        '喜び',
        '歓び',
        '祝福',
        '愛',
        '恋',
        'ワクワク',
        'ときめき',
      ],
    },
  ];

  for (const key of qKeywords) {
    let hits = 0;
    for (const pat of key.patterns) {
      if (text.includes(pat)) {
        qScores[key.q] += key.weight;
        hits++;
      }
    }
    if (hits > 0) {
      debug.push(`${key.note} ヒット数=${hits} → ${key.q} に +${(key.weight * hits).toFixed(1)}`);
    }
  }

  // 最大スコアの Q を採用（代表Q）
  let qCode: QCode = 'Q2';
  let maxQScore = -Infinity;
  for (const q of Object.keys(qScores) as QCode[]) {
    if (qScores[q] > maxQScore) {
      maxQScore = qScores[q];
      qCode = q;
    }
  }
  debug.push(`最終 QCode = ${qCode} (score=${maxQScore.toFixed(2)})`);

  // -----------------------------
  // 1-2. Q分布（連続値）の算出
  // -----------------------------
  const qDistribution: QDistribution = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
    Q5: 0,
  };

  let totalQ = 0;
  for (const q of Object.keys(qScores) as QCode[]) {
    const v = qScores[q] < 0 ? 0 : qScores[q]; // マイナスは 0
    qDistribution[q] = v;
    totalQ += v;
  }

  if (totalQ > 0) {
    for (const q of Object.keys(qDistribution) as QCode[]) {
      qDistribution[q] = qDistribution[q] / totalQ;
    }
  } else {
    // まれに全て 0 の場合は均等分布（安全策）
    for (const q of Object.keys(qDistribution) as QCode[]) {
      qDistribution[q] = 1 / 5;
    }
    debug.push('Q分布: 有効スコアが 0 のため、均等分布(0.2)を採用');
  }

  debug.push(
    `Q分布: ` +
      (Object.keys(qDistribution) as QCode[])
        .map((q) => `${q}=${qDistribution[q].toFixed(2)}`)
        .join(', '),
  );

  // -----------------------------
  // 2. IN / OUT（phase）の推定
  // -----------------------------
  const innerWords = ['私', 'わたし', '自分', '心', '内側', '本音', '内面', '感情', '気持ち', '傷'];
  const outerWords = ['世界', '日本', '社会', '人々', 'みんな', '誰か', '家族', '子ども', '子供', '相手', '周り', '地域', '会社'];

  let innerScore = 0;
  let outerScore = 0;

  for (const w of innerWords) {
    if (text.includes(w)) innerScore += 1;
  }
  for (const w of outerWords) {
    if (text.includes(w)) outerScore += 1;
  }

  // ヒットがまったく無い場合は mood からざっくり決める
  if (innerScore === 0 && outerScore === 0) {
    if (mood === '静けさ' || mood === '不安' || mood === '迷い') {
      innerScore += 1;
      debug.push('phase: キーワード無し → mood から inner 寄りに補正');
    }
    if (mood === '希望' || mood === '情熱' || mood === '感謝') {
      outerScore += 0.5; // 少しだけ outer 方向
      debug.push('phase: キーワード無し → mood から outer を少し加点');
    }
  }

  const phase: Phase = innerScore >= outerScore ? 'inner' : 'outer';
  debug.push(`phase 判定: inner=${innerScore}, outer=${outerScore} → ${phase.toUpperCase()} を採用`);

  // -----------------------------
  // 3. Tコードのスコアリング
  // -----------------------------
  const tScores: Record<TCode, number> = {
    T1: 0,
    T2: 0,
    T3: 0,
    T4: 0,
    T5: 0,
  };

  type TKey = { patterns: string[]; t: TCode; weight: number; note: string };

  const tKeywords: TKey[] = [
    {
      t: 'T1',
      weight: 1.5,
      note: 'T1(始まり・起点)ワード',
      patterns: ['始めたい', '始める', '一歩', 'スタート', 'きっかけ', '種', '出会い', '入口'],
    },
    {
      t: 'T2',
      weight: 1.5,
      note: 'T2(関係・流れ)ワード',
      patterns: ['関係', 'つながり', '繋がり', '循環', '交流', '流れ', 'ネットワーク', 'フィールド', '場'],
    },
    {
      t: 'T3',
      weight: 1.5,
      note: 'T3(本質・使命)ワード',
      patterns: ['使命', '本質', '真実', '真理', '核', 'コア', '軸', 'ビジョン', '存在意義', '魂'],
    },
    {
      t: 'T4',
      weight: 1.5,
      note: 'T4(統合・解放)ワード',
      patterns: ['統合', '解放', '溶ける', '境界', '和解', '赦す', '許す', '手放す', '癒し', '癒やし', '回復'],
    },
    {
      t: 'T5',
      weight: 1.5,
      note: 'T5(影響・世界)ワード',
      patterns: ['世界', '社会', '日本', '地球', '未来', '影響', 'インパクト', '貢献', '広げる', '届ける'],
    },
  ];

  for (const key of tKeywords) {
    let hits = 0;
    for (const pat of key.patterns) {
      if (text.includes(pat)) {
        tScores[key.t] += key.weight;
        hits++;
      }
    }
    if (hits > 0) {
      debug.push(`${key.note} ヒット数=${hits} → ${key.t} に +${(key.weight * hits).toFixed(1)}`);
    }
  }

  // キーワードが弱いときの mood 補正
  const tTotal = Object.values(tScores).reduce((a, b) => a + b, 0);
  if (tTotal === 0) {
    switch (mood) {
      case '静けさ':
        tScores.T4 += 1;
        debug.push('T補正: 静けさ → T4(統合・静けさ) を加点');
        break;
      case '希望':
        tScores.T2 += 1;
        debug.push('T補正: 希望 → T2(関係・流れ) を加点');
        break;
      case '情熱':
        tScores.T3 += 1;
        tScores.T5 += 0.5;
        debug.push('T補正: 情熱 → T3/T5 を加点');
        break;
      case '不安':
        tScores.T1 += 0.5;
        tScores.T4 += 1;
        debug.push('T補正: 不安 → T4(+T1少し) を加点');
        break;
      case '迷い':
        tScores.T1 += 0.5;
        tScores.T2 += 0.5;
        debug.push('T補正: 迷い → T1/T2 を少し加点');
        break;
      case '感謝':
        tScores.T2 += 0.5;
        tScores.T5 += 0.5;
        debug.push('T補正: 感謝 → T2/T5 を少し加点');
        break;
    }
  }

  let tCode: TCode = 'T2';
  let maxTScore = -Infinity;
  for (const t of Object.keys(tScores) as TCode[]) {
    if (tScores[t] > maxTScore) {
      maxTScore = tScores[t];
      tCode = t;
    }
  }
  debug.push(`最終 TCode = ${tCode} (score=${maxTScore.toFixed(2)})`);

  // -----------------------------
  // 4. confidence の簡易算出
  // -----------------------------
  const rawTotal = maxQScore + maxTScore;
  const confidence = Math.max(0.1, Math.min(1, rawTotal / 8)); // 適当に 0〜1 に正規化

  return {
    qCode,
    qDistribution,
    phase,
    tCode,
    confidence,
    debugNotes: debug,
  };
}
