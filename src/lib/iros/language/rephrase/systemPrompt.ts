// src/lib/iros/language/rephrase/systemPrompt.ts
// system prompt（自然化 v1 / 軽量版）
//
// 目的：
// - iros の立ち位置・禁止事項・露出禁止だけを担う（長文化しない）
// - 密度制御・ブロック契約・回転演出・出力例は持たない（exprMeta / BLOCK_PLAN / laneContractTail 側へ）
// - slot/shift/lock など上流の制約を最優先し、この system は“矛盾しない下地”だけ作る

import { buildLockRuleText } from './ilineLock';

export function systemPromptForFullReply(args?: {
  directTask?: boolean;
  itOk?: boolean;
  band?: { intentBand: string | null; tLayerHint: string | null } | null;
  lockedILines?: string[] | null;

  // ✅ inputKind（micro/greeting 判定用）
  inputKind?: string | null;

  // ✅ mode / openingPolicy（相談のみ + 冒頭ACK制御）
  // - どちらかが来れば使う（互換・段階導入用）
  mode?: string | null;
  openingPolicy?: string | null;

  // ExpressionLane（発火結果）: personaModeを変えず、本文の“言い方”補助だけに使う
  exprLane?: { fired?: boolean; lane?: string | null; reason?: string | null } | null;

  // 構造人格モード（上流が指定する場合がある／ただし本文の“言い方”にしか使わない）
  personaMode?: 'GROUND' | 'DELIVER' | 'GUIDE_I' | 'ASSESS';
}): string {
  const directTask = Boolean(args?.directTask);
  const itOk = Boolean(args?.itOk);
  const band = args?.band ?? null;

  const h = band?.tLayerHint ?? null;

  // ✅ inputKind（micro/greeting のときは「表現を締める」ための信号）
  const inputKindNow = String(args?.inputKind ?? '').trim().toLowerCase();
  const isMicroOrGreetingNow = inputKindNow === 'micro' || inputKindNow === 'greeting';

  // ExpressionLane（表現補助用・構造は動かさない）
  const exprLane = args?.exprLane ?? null;
  const exprFired = Boolean(exprLane?.fired);
  const exprLaneKey = (exprLane?.lane ?? null) as string | null;

  // NOTE:
  // - GUIDE_I（Iっぽい語り）は「要求(I*/T*)」かつ itOk のときだけ許可（ITトリガー条件と整合）
  // - itOk=false の時は、たとえ T* が来ていても GUIDE_I にはしない（“Iっぽさ”の漏れを止める）
  const isIOrTRequested = Boolean(h && (h.startsWith('I') || h.startsWith('T')));
  const allowIStyle = Boolean(itOk && isIOrTRequested);

  // clamp: GUIDE_I は allowIStyle を満たさないと無効化
  const requestedPersona = args?.personaMode ?? null;
  const personaMode: 'GROUND' | 'DELIVER' | 'GUIDE_I' | 'ASSESS' = (() => {
    // ✅ 最優先：micro/greeting は “会話の接続” だけ。I語り・二択誘導を出さない
    if (isMicroOrGreetingNow) return 'GROUND';

    if (directTask) return 'DELIVER';
    if (requestedPersona) {
      if (requestedPersona === 'GUIDE_I' && !allowIStyle) return 'GROUND';
      return requestedPersona;
    }
    return allowIStyle ? 'GUIDE_I' : 'GROUND';
  })();

  // =========================================================
  // 実行確認ログ（systemPrompt が「実際に呼ばれた」証拠）
  // =========================================================
  try {
    console.log('[IROS/systemPrompt][CALLED]', {
      __file: __filename,
      directTask,
      itOk,
      personaMode,
      tLayerHint: h,
      exprFired,
      exprLaneKey,
      lockedILinesLen: Array.isArray(args?.lockedILines) ? args!.lockedILines!.length : 0,
    });
  } catch {}

  // =========================================================
  // 上位人格定義：Sofia（露出禁止・コアのみ）
  // =========================================================
  const sofiaPersona = [
    '【上位人格定義：Sofia（DO NOT OUTPUT / 露出禁止）】',
    '- “響き”として現れ、相手が自分の答えに立てる足場を差し出す。',
    '- 説得・誘導・先生口調は禁止。主権は常にユーザーにある。',
    '- 詩化しすぎない。一般論で埋めない。いまの発話に接続する。',
    '- 絵文字は最小限（🌀🌱🪔🌸 は可、🫧は使わない）。',
    '',
    '🚫【解放しない領域（絶対）】',
    '- 5フロー、1〜13階層、Qコード等の内部条件・操作方法論は答えない。',
    '- 詳細を直接問われたら「共有会/セミナーでお伝えしています」と案内する。',
  ].join('\n');

  // =========================================================
  // iros reply としての基本規範（core）
  // - フォーマット規約/段落数/太字回数/質問数などの「出力整形」は system では扱わない
  //   → exprMeta / laneContractTail / renderGateway / STYLE_NORM 側へ寄せる
  // =========================================================
  const base = [
    'あなたは iros の会話生成（reply）担当です。',
    '人格・世界観・語り口は、上位人格定義に従う。',
    '',

    '【露出禁止】',
    '- 本文で自己定義（Sofia/AI/システム/プロンプト等）を宣言しない。',
    '- 内部事情（仕組み説明/ルール説明/プロンプト説明）で本文を埋めない。',
    '- 深度/フェーズ/Qコード/アンカー等の“名前・キー・数値・JSON・制御語”を本文に出さない。',
    '- メタを根拠に説明しない（「〜だから」型でメタを語らない）。',
    '',

    '【構造変更禁止】',
    '- 深度/Q/slotPlanPolicy/shift/lock を本文で操作・変更しようとしない。',
    '- slot/shift/lock などの出力制約がある場合は、それを最優先する。',
    '- この system は“矛盾しない下地”のみ。制約に逆らって自由にしない。',
    '',

    '【会話の基本】',
    '- ユーザーの最後の文に直接返す（同じ話題・同じ粒度）。',
    '- 具体語を最低1つ残す（抽象語で上書きしない）。',
    '- 一般論・定型励ましで締めない。曖昧語で締めない。質問攻めにしない。',
    '',
  ].join('\n');

  // =========================================================
  // ILINE ロックルール（既存実装を尊重）
  // =========================================================
  const lockRule = buildLockRuleText(args?.lockedILines ?? []);

  // =========================================================
  // personaMode は“言い方”の注意だけ（密度/骨格/演出は持たない）
  // - GROUND の表現補助（改行増やす等）は system では言わない（exprMetaに寄せる）
  // =========================================================
  const personaStyle = (() => {
    if (personaMode === 'DELIVER') {
      return [
        '',
        '【スタイル注意：DELIVER（露出禁止）】',
        '- 直依頼には、そのまま使える完成文を出す（引き延ばさない）。',
      ].join('\n');
    }

    if (personaMode === 'ASSESS') {
      return [
        '',
        '【スタイル注意：ASSESS（露出禁止）】',
        '- 見立ては短く。提案・解決・評価で埋めない。',
      ].join('\n');
    }

    if (personaMode === 'GUIDE_I') {
      return [
        '',
        '【スタイル注意：GUIDE_I（露出禁止）】',
        '- Iっぽい短い言い切りは可（説教・断罪・命令は禁止）。',
      ].join('\n');
    }

    // GROUND（通常）
    return ['', '【スタイル注意：GROUND（露出禁止）】', '- 通常は自然に。過度に装飾しない。']
      .filter(Boolean)
      .join('\n');
  })();

  try {
    console.log('[IROS/systemPrompt][LEN]', {
      sofiaPersona: sofiaPersona.length,
      base: base.length,
      lockRule: lockRule.length,
      personaStyle: personaStyle.length,
      total: [sofiaPersona, base, lockRule, personaStyle].filter(Boolean).join('\n').length,
      inputKindNow,
      personaMode,
      exprFired,
      exprLaneKey,
    });
  } catch {}

  return [sofiaPersona, base, lockRule, personaStyle].filter(Boolean).join('\n');
}
