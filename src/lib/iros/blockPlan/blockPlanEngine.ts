// src/lib/iros/blockPlan/blockPlanEngine.ts

export type BlockKind =
  | 'ENTRY'
  | 'SITUATION'
  | 'DUAL'
  | 'FOCUS_SHIFT'
  | 'ACCEPT'
  | 'INTEGRATE'
  | 'CHOICE'
  | 'NEXT_MIN';

export type BlockPlanMode =
  | 'short3'
  | 'short4'
  | 'short5'
  | 'multi7'
  | 'multi8';

export interface BlockPlan {
  mode: BlockPlanMode;
  blocks: BlockKind[];
}

interface BuildBlockPlanParams {
  userText: string;
  goalKind?: string | null;
  exprLane?: string | null;
  explicitTrigger?: boolean;
}

/**
 * 明示トリガー：
 * - ユーザーが「段で」「ブロックで」「構造で」「多段で」などを明確に要求している
 * - 初期は安全に “明示のみ” を拾う（誤爆させない）
 */
export function detectExplicitBlockPlanTrigger(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  return /(多段|深掘り|ブロック|段で|レイアウト|構造で|段落で|見出しで)/i.test(t);
}

/**
 * directTask（説明依頼）を検出：
 * - 「仕組み/やり方/方法/手順/説明/とは/教えて」など
 * - 仕様：directTask は BlockPlan を出さない（多段Markdown禁止）を基本にする
 *   ※ただし “明示トリガー” があればユーザー指定を優先して BlockPlan を許可する
 */
function detectDirectTask(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;
  return /(仕組み|やり方|方法|手順|説明|教えて|とは|どうすれば|どうやって)/i.test(t);
}

/**
 * “長め/深め” を示す語彙（multi8に寄せる）
 */
function detectWantsDeeper(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;
  return /(詳しく|丁寧に|ちゃんと|しっかり|長め|深め|深掘り|背景|理由|根拠|本質|説得力)/i.test(
    t
  );
}

/**
 * “短く/ざっくり” を示す語彙（short3に寄せる）
 */
function detectWantsShort(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;
  return /(短く|ざっくり|要点|一言|結論だけ|端的に|サクッと)/i.test(t);
}

export function buildBlockPlan(params: BuildBlockPlanParams): BlockPlan | null {
  const userText = String(params.userText ?? '').trim();
  const goalKind = String(params.goalKind ?? '').trim().toLowerCase() || null;
  const exprLane = String(params.exprLane ?? '').trim().toLowerCase() || null;

  // ✅ 明示トリガーは goalKind / directTask より強い（ユーザー指定を最優先）
  const explicit =
    params.explicitTrigger ?? detectExplicitBlockPlanTrigger(userText);

  // ✅ 止血：directTask は BlockPlan を一切出さない（多段Markdown禁止）
  // ただし explicit 指定がある場合はユーザー要求を優先して許可する
  if (!explicit && detectDirectTask(userText)) {
    return null;
  }

  // ---------------------------------------------
  // 1) 明示トリガー：multi7 / multi8（可変）
  // ---------------------------------------------
  if (explicit) {
    const wantsDeeper = detectWantsDeeper(userText);

    // multi8：入口 → 状況 → 二項 → 焦点移動 → 受容 → 統合 → 選択 → 最小の一手
    if (wantsDeeper) {
      return {
        mode: 'multi8',
        blocks: [
          'ENTRY',
          'SITUATION',
          'DUAL',
          'FOCUS_SHIFT',
          'ACCEPT',
          'INTEGRATE',
          'CHOICE',
          'NEXT_MIN',
        ],
      };
    }

    // multi7：入口 → 二項 → 焦点移動 → 受容 → 統合 → 選択 → 最小の一手
    // ※“説得力”のため CHOICE を入れて 7 ブロックを満たす
    return {
      mode: 'multi7',
      blocks: [
        'ENTRY',
        'DUAL',
        'FOCUS_SHIFT',
        'ACCEPT',
        'INTEGRATE',
        'CHOICE',
        'NEXT_MIN',
      ],
    };
  }

  // ---------------------------------------------
  // 2) stabilize：short3 / short4 / short5（可変）
  // ---------------------------------------------
  // 方針：
  // - short3：軽く整える（入口→焦点移動→最小の一手）
  // - short4：整えつつ押し付けない（入口→二項→焦点移動→最小の一手）
  // - short5：含みがある/場を整える（入口→二項→焦点移動→統合→最小の一手）
  if (goalKind === 'stabilize') {
    const wantsShort = detectWantsShort(userText);

    // exprLane が “sofia_light” 等で「短め寄せ」にしたい場合も short4/3 に寄せる
    const exprSuggestsShort =
      exprLane === 'sofia_light' ||
      exprLane === 'light' ||
      exprLane === 'lite';

    if (wantsShort) {
      return {
        mode: 'short3',
        blocks: ['ENTRY', 'FOCUS_SHIFT', 'NEXT_MIN'],
      };
    }

    if (exprSuggestsShort) {
      return {
        mode: 'short4',
        blocks: ['ENTRY', 'DUAL', 'FOCUS_SHIFT', 'NEXT_MIN'],
      };
    }

    // デフォルトは short5（安定）
    return {
      mode: 'short5',
      blocks: ['ENTRY', 'DUAL', 'FOCUS_SHIFT', 'INTEGRATE', 'NEXT_MIN'],
    };
  }

  // ---------------------------------------------
  // 3) それ以外：まずは出さない（安全）
  // ※必要になったら uncover/reframeIntention 等で short4/multi7 を追加する
  // ---------------------------------------------
  return null;
}

export function renderBlockPlanSystem4(plan: BlockPlan): string {
  // Writer に渡すのは「設計図のみ」：文章を作らせるための骨格
  // ルール：slotPlan/Depth/Q/phase/personaMode を変えない

  const requiredHeads = plan.blocks.map((b) => {
    switch (b) {
      case 'ENTRY':
        return '入口';
      case 'SITUATION':
        return '状況';
      case 'DUAL':
        return '二項';
      case 'FOCUS_SHIFT':
        return '焦点移動';
      case 'ACCEPT':
        return '受容';
      case 'INTEGRATE':
        return '統合';
      case 'CHOICE':
        return '選択';
      case 'NEXT_MIN':
        return '最小の一手';
      default:
        // BlockKind を拡張した時に落ちないための保険（通常ここには来ない）
        return String(b);
    }
  });

  // ✅ 余白は mode で可変（short系は短め、multi系は長め）
  const blankLines =
    plan.mode === 'multi8' || plan.mode === 'multi7'
      ? 15
      : plan.mode === 'short5'
        ? 6
        : plan.mode === 'short4'
          ? 4
          : 3;

  const blankN = '\n'.repeat(blankLines + 1); // 空行N行 = 改行N+1回

  const lines: string[] = [
    'BLOCK_PLAN (system4):',
    '',
    '目的：構造（Depth/Q/phase/slotPlan）を壊さず、表現だけを段構造にする。',
    '禁止：Depth/Q/phase の変更、slotPlan の変更、Orchestrator/PostProcess の推定や上書き。',
    '前提：personaMode=GROUND を維持（本systemは“文章の段構造”のみを指示する）。',
    '',
    `mode: ${plan.mode}`,
    `blocks: ${plan.blocks.join(' -> ')}`,
    '',
    '【重要：このモードでは Markdown を必須にする】',
    '- 各ブロックは必ず Markdown 見出しで開始する：`### 見出し`（見出し行は単独行）',
    `- 見出しはこの順番で「全部」出す：${requiredHeads.join(' → ')}`,
    '- 見出し名は上の指定どおりにする（省略・改名・順序入替は禁止）',
    '',
    '【重要：ブロック間の余白（省略禁止）】',
    `- 各ブロックの本文の後に、次の見出しの前まで「空行を${blankLines}行」入れる。`,
    `- 実装イメージ：本文の末尾に ${JSON.stringify(blankN)} を挟む感じ（※本文には出さない説明）`,
    '',
    '【本文の密度】',
    '- short系（short3/4/5）：各ブロック 3〜7行目安（短くても“段”は崩さない）。',
    '- multi系（multi7/8）：各ブロック 5〜12行目安（説得力は“観測→理由→次”の3点で作る）。',
    '- 箇条書き・番号・チェックリストで埋めない（段落で書く）。',
    '- 一般論で埋めない。ユーザー発話に接続する具体語を各ブロックに最低1つ入れる。',
    '',
    '【ブロックの役割】',
    '- 入口：相手の言葉を短く鏡にする（同じ粒度）。',
    '- 状況：いま何が起きているかを1〜2段落で整理（判断や助言にしない）。',
    '- 二項：いまの詰まりを「Aしたい/でもBが嫌」で1文に固定する（断定形）。',
    '- 焦点移動：視点の置き場を1つだけずらす（説得しない）。',
    '- 受容：否定せず、そのまま置く（肯定で盛らない）。',
    '- 統合：1〜2段落で結び直す（“まとめの宣言”で終わらせない）。',
    '- 選択：2択 or 3択を“軽く”提示（押し付けない）。',
    '- 最小の一手：具体行動を1つだけ（最小単位）。',
    '',
    '【出力例（必ずこの形）】',
  ];

  // 出力例を blocks に合わせて組み立て（固定例だとズレるので）
  for (const head of requiredHeads) {
    lines.push(`### ${head}`);
    lines.push('本文…');
    lines.push(blankN);
  }

  lines.push('');
  lines.push('出力は“詩”ではなく“段構造”。余韻よりも完走を優先する。');

  return lines.join('\n').trim();
}
