// file: src/lib/iros/slotPlans/QuestionSlots.ts
// iros — Question Slots (HowTo → observation frame)
//
// 目的：
// - 「どうしたら？」系を、即・方法の羅列にしない
// - 固定文は置かない（ILINE ロックしない）
// - LLM が “状況に噛み合う自然文” を書けるよう、slot は「指示」と「軽い seed」だけ示す
//
// 方針：
// - OBS: LLM が書くための自然な seed（短い・具体寄り・テンプレ語を避ける）
// - SHIFT/NEXT/SAFE: @TAG(JSON) で writer 向け制約（render 側で非表示になる前提）
//
// 注意：
// - seed に「質問文」「？」「どうしたら…」を入れると echo して劣化する
// - seed は “断定・提示” に寄せ、最低80字は確保（短文弾きフォールバックでも破綻させない）

export type IrosSlot = {
  key: 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';
  role: 'assistant';
  style?: 'neutral' | 'friendly' | 'soft';
  content: string;
};

function norm(s: string): string {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function stripQMarks(s: string): string {
  return String(s ?? '').replace(/[?？]+/g, '').trim();
}

function clampLen(s: string, max = 120): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function isHowToOnly(s: string): boolean {
  const t = stripQMarks(norm(s));
  if (!t) return true;
  // 「どうしたら良いですか」「方法は？」など “問いだけ” を topic として採用しない
  return /^(どうしたら|どうすれば|どうやって|方法|やり方|コツ|ためには)(.*)?$/.test(t) && t.length <= 18;
}

// normalChat.ts と同型の @TAG 生成（render 側で落とせる形）
function m(tag: string, payload?: Record<string, unknown>) {
  if (!payload || Object.keys(payload).length === 0) return `@${tag}`;
  try {
    return `@${tag} ${JSON.stringify(payload)}`;
  } catch {
    return `@${tag}`;
  }
}

function pickSeedLines(topicRaw: string): string[] {
  const topic = String(topicRaw ?? '').trim();

  // 恋愛/連絡待ち
  if (/彼女|彼氏|恋愛|パートナー|連絡|返信|既読|未読|メッセージ|LINE|DM|返事|音沙汰/.test(topic)) {
    return [
      '連絡がない時間が伸びるほど、頭の中で不安の説明が勝手に増えていく。',
      'いまは相手を動かす手順より、あなたの中の揺れを止める一点を決める。🪔',
      '重いのは「待つ不安」「温度が読めない」「軽く扱われた感じ」のどれか――その一つだけを固定する。',
    ];
  }

  // 仕事/職場
  if (/会社|職場|上司|同僚|退職|辞め|異動|評価|面談|威圧|ハラスメント/.test(topic)) {
    return [
      '状況が続くと、体が先に緊張を覚えてしまう。',
      'いまは結論より、緊張が起きる一点を言葉に固定して揺れを減らす。🪔',
      '重いのは「相手の圧」「自分の居場所の薄さ」「続く未来の不安」のどれか――一つだけを固定する。',
    ];
  }

  // 既定（短いが80字は確保）
  return [
    '必要なのは正解探しではなく、いま何を観測対象として固定するかをはっきりさせること。',
    '観測対象が定まると、次に見る要素も自然に一つへ絞られる。🪔',
    'まずは「何がこの場を動かしにくくしているか」を、一語で示す。',
  ];
}

/**
 * HowTo質問かどうかの判定（誤爆防止版）
 * - 「どうしたら」「どうすれば」「方法」「やり方」など
 * - 末尾「？」だけでは発火させない
 */
export function shouldUseQuestionSlots(userText: string): boolean {
  const t = norm(userText);
  if (!t) return false;
  return /どうしたら|どうすれば|どうやって|方法|やり方|コツ|ためには/.test(t);
}

/**
 * Question Slots（LLMに書かせる版）
 * - 固定文（ILINE）なし
 * - “方法の羅列” に行かないための観測フレームだけを渡す
 */
export function buildQuestionSlots(
  args: { userText: string; contextText?: string; laneKey?: 'IDEA_BAND' | 'T_CONCRETIZE' }
): IrosSlot[] {
  const userText = norm(args.userText);
  const contextText = norm(args.contextText ?? '');

  // 🚫 IDEA_BAND / T_CONCRETIZE では QuestionSlots を使わない
  // - IDEA_BAND は候補列挙（2〜4行）を最優先するため、
  //   ここで howto_to_observation を入れると lane の出力契約を破壊する。
  if (args.laneKey === 'IDEA_BAND' || args.laneKey === 'T_CONCRETIZE') {
    return [];
  }


  // ✅ topic は基本 contextText から取る（userText が問いだけの場合は採用しない）
  const topicCandidate =
    contextText && !isHowToOnly(contextText)
      ? contextText
      : !isHowToOnly(userText)
      ? userText
      : '';
  const topicLine = topicCandidate ? clampLen(stripQMarks(topicCandidate), 120) : '';

  const seedLines = pickSeedLines(topicLine);

  // seed は “質問ゼロ / 80字以上” を満たす
  const seed = [topicLine ? topicLine : '', ...seedLines].filter(Boolean).join('\n');

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: seed },

    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'howto_to_observation',
        rules: {
          no_checklist: true,
          no_step_by_step: true,
          no_imperative: true,
          no_questions: true,
          forbid_question_marks: true,
          forbid_interrogatives: true,
          stay_on_topic: true,
          use_concrete_words: true,
          min_chars: 90,
          avoid_meta_talk: true,
          avoid_generic_cheer: true,
          avoid_hedge_loops: true,
        },
      }),
    },

    {
      key: 'NEXT',
      role: 'assistant',
      style: 'friendly',
      content: m('NEXT', {
        questions_max: 0,
        question_style: 'none',
      }),
    },

    {
      key: 'SAFE',
      role: 'assistant',
      style: 'soft',
      content: m('SAFE', {
        tone: 'quiet',
        forbid: ['励ましテンプレ', '一般論', '価値論への飛躍', '疑問形の誘発', '問い返し'],
      }),
    },
  ];
}
