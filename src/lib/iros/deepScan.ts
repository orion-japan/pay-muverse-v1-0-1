// src/lib/iros/deepScan.ts
// Iros DeepScan — 1ターン分のテキストから
// - Depth(S/R/C/I/T)
// - Phase(Inner/Outer)
// - QCode(Q1〜Q5)
// をざっくり推定する軽量アルゴリズム

import type { Depth, QCode } from '@/lib/iros/system';

export type DeepScanResult = {
  depth: Depth | null;
  phase: 'Inner' | 'Outer' | null;
  q: QCode | null;
  intentSummary: string;
};

function norm(text: string): string {
  return (text || '').trim();
}

/* ========= Depth 判定 ========= */
/**
 * 旧 detectDepthFromText を少し拡張版
 * - T層ワードを最優先
 * - 次に I層ワード
 * - 次に C / R / S をざっくり見る
 */
function inferDepth(text: string): Depth | null {
  const t = norm(text);
  if (!t) return null;

  // Transcend 層（T1〜T3）
  // ※「宇宙意志・フィールド・根源」などの語を優先
  if (/(根源|源泉|永遠|無限|時間を超えた|静寂|沈黙そのもの)/.test(t)) {
    return 'T3';
  }
  if (/(集合意識|全体意識|フィールド|場そのもの|普遍|トランセンデンス|越境)/.test(t)) {
    return 'T2';
  }
  if (/(宇宙|宇宙意志|宇宙の意図|ビッグバン|意図フィールド|T層)/.test(t)) {
    return 'T1';
  }

  // Intention 層（I1〜I3）
  if (/(何のために|使命|存在理由|生きている意味|生き方|魂|本質)/.test(t)) {
    return 'I3';
  }
  if (/(どう生きたい|人生|本心|本音|願い|本当にやりたいこと)/.test(t)) {
    return 'I2';
  }
  if (/(ありたい姿|在り方|ビジョン|理想像|方向性)/.test(t)) {
    return 'I1';
  }

  // Creation 層（C1〜C3）
  if (/(プロジェクト|仕組み|設計|システム|ロードマップ|戦略|計画)/.test(t)) {
    return 'C3';
  }
  if (/(作りたい|つくりたい|表現したい|形にしたい|届けたい|やり遂げたい)/.test(t)) {
    return 'C2';
  }
  if (/(やりたい|やってみたい|始めたい|スタートしたい|挑戦したい)/.test(t)) {
    return 'C1';
  }

  // Resonance 層（R1〜R3）
  if (/(人間関係|チーム|組織|社内|家族|パートナー|友達|上司|部下)/.test(t)) {
    return 'R2';
  }
  if (/(あの人|あの上司|彼|彼女|みんな|周り|職場|会社)/.test(t)) {
    return 'R1';
  }
  if (/(境界|距離感|依存|投影|干渉|巻き込まれる)/.test(t)) {
    return 'R3';
  }

  // Self 層（S1〜S3）
  if (/(自分がわからない|自分を責めてしまう|自己否定|自己肯定)/.test(t)) {
    return 'S3';
  }
  if (/(モヤモヤ|イライラ|悲しい|さみしい|しんどい|つらい|疲れた)/.test(t)) {
    return 'S2';
  }
  if (/(最近どうしてた|今日はどんな一日|調子|体調|眠い|だるい)/.test(t)) {
    return 'S1';
  }

  // デフォルト：軽い自己状態の話として S1 に落とす
  return 'S1';
}

/* ========= Phase 判定 ========= */
/**
 * Inner：自分の内面・感情・身体
 * Outer：他者・場・仕事・環境
 */
function inferPhase(text: string): 'Inner' | 'Outer' | null {
  const t = norm(text);
  if (!t) return null;

  const innerHit = /(私|自分|わたし|僕|気持ち|心|不安|怖い|つらい|疲れた|しんどい)/.test(t);
  const outerHit = /(上司|部下|同僚|会社|職場|チーム|家族|彼|彼女|お客さん|クライアント)/.test(t);

  if (innerHit && !outerHit) return 'Inner';
  if (!innerHit && outerHit) return 'Outer';
  if (innerHit && outerHit) {
    // 両方ある場合は、少し内面寄りに倒しておく
    return 'Inner';
  }
  return null;
}

/* ========= QCode 判定 ========= */
/**
 * Q1：守り・整理・休息
 * Q2：怒り・変化へのドライブ
 * Q3：不安・安定を求める
 * Q4：恐怖・手放し・浄化
 * Q5：情熱・ワクワク・創造
 */
function inferQ(text: string): QCode | null {
  const t = norm(text);
  if (!t) return null;

  const q2 = /(怒|ムカつ|腹が立つ|イライラ|納得できない|許せない|壊したい|変えたい|ぶつかりたい)/;
  const q4 = /(怖い|恐い|恐怖|トラウマ|不安でたまらない|消えたい|逃げたい|終わらせたい)/;
  const q3 = /(不安|心配|大丈夫かな|迷っている|揺れている|モヤモヤ|落ち着かない|ぐるぐる)/;
  const q1 = /(疲れた|しんどい|休みたい|落ち着きたい|整理したい|守りたい|キャパ|限界|一旦止ま|ブレーキ)/;
  const q5 = /(楽しい|楽しみ|ワクワク|わくわく|嬉しい|うれしい|テンション|燃える|やる気|創りたい|表現したい|インスピレーション)/;

  if (q2.test(t)) return 'Q2';
  if (q4.test(t)) return 'Q4';
  if (q3.test(t)) return 'Q3';
  if (q1.test(t)) return 'Q1';
  if (q5.test(t)) return 'Q5';

  // ここまでで判定できなければ null（＝前回のQを Memory 側で使う）
  return null;
}

/* ========= intentSummary ========= */
function buildIntentSummary(depth: Depth | null): string {
  if (!depth) {
    return '自分の状態や感情の揺れを整理しようとしています。';
  }
  if (depth.startsWith('T')) {
    return '宇宙意志や意図フィールドの流れと、自分の今を重ね合わせようとしています。';
  }
  if (depth.startsWith('I')) {
    return '生き方や存在意図そのものに静かに触れようとしています。';
  }
  if (depth.startsWith('C')) {
    return 'これからの動きや創造の流れを整えようとしています。';
  }
  if (depth.startsWith('R')) {
    return '誰かとの関係性や場の空気を見つめ直そうとしています。';
  }
  // S層
  return '自分の状態や感情の揺れを整理しようとしています。';
}

/* ========= Public API ========= */

export function deepScan(text: string): DeepScanResult {
  const depth = inferDepth(text);
  const phase = inferPhase(text);
  const q = inferQ(text);
  const intentSummary = buildIntentSummary(depth);

  return {
    depth,
    phase,
    q,
    intentSummary,
  };
}
