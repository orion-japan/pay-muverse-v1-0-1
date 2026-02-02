// src/lib/iros/orchestratorMode.ts
// Iros モード決定ヘルパー
// - mirror / vision / diagnosis のモードを確定
// - ついでに「レポート寄り」のプレゼンヒントも meta に付与

import {
  IROS_MODES,
  type IrosMode,
  type IrosMeta,
  type TLayer,
} from '@/lib/iros/system';
import type { IntentLineAnalysis } from './intent/intentLineEngine';

/* ========= オプション型 ========= */

type ApplyModeOptions = {
  requestedMode?: IrosMode;
  meta: IrosMeta;
  isFirstTurn?: boolean;
  intentLine?: IntentLineAnalysis | null;
  tLayerHint?: TLayer | null;
  forceILayer?: boolean;
};

/* ========= ユーティリティ ========= */

// IROS_MODES に含まれているものだけ許可
function normalizeMode(mode?: IrosMode | null): IrosMode | null {
  if (!mode) return null;
  return IROS_MODES.includes(mode) ? mode : null;
}

/* ========= モード決定の本体 ========= */

export function applyModeToMeta(
  userText: string,
  options: ApplyModeOptions,
): IrosMeta {
  const {
    requestedMode,
    meta,
    isFirstTurn,
    intentLine,
    tLayerHint,
    forceILayer,
  } = options;

  const next: IrosMeta = { ...meta };
  const text = userText.trim();

  // 1) ベースモードの決定
  //    - requestedMode があれば最優先
  //    - なければ meta.mode（前ターンのモード）を継承
  //    - どちらも無ければ mirror
  let baseMode: IrosMode = 'mirror';

  const req = normalizeMode(requestedMode);
  const prev = normalizeMode(next.mode as IrosMode | undefined);

  if (req) {
    baseMode = req;
  } else if (prev) {
    baseMode = prev;
  } else {
    baseMode = 'mirror';
  }

  // 2) ちょっとだけ自動判定（vision 寄りにする条件）
  //    ※ 今は控えめにしておく：UI ボタンで指定したときがメイン
  if (!req) {
    // ▼ ユーザーからの「ビジョン連れてって」系の言葉があれば、優先して vision
    const wantsVision =
      /もっと想像させて|ビジョンを見せて|先の世界を教えて|なったあとの世界を見たい|その先の景色を一緒に見たい|ここに連れていってほしい|思い出させてほしい/.test(
        text,
      );

    if (wantsVision) {
      baseMode = 'vision';
    } else {
      // T層ヒントがある・または I層深度にいるときは、軽く vision に寄せる
      const depth = next.depth;
      const isIntentDepth =
        depth === 'I1' ||
        depth === 'I2' ||
        depth === 'I3' ||
        depth === 'T1' ||
        depth === 'T2' ||
        depth === 'T3';

      if (tLayerHint && isIntentDepth) {
        baseMode = 'vision';
      }
    }
  }

  // 診断モードは、ir診断のトリガー（system 側）を優先
  // → ここでは特に自動で diagnosis にはしない

  next.mode = baseMode;

  // 3) レポート系プレゼンのヒント
  //
  // - meta.presentationKind を追加（string なので自由に使える）
  //   'vision'  : 未来の絵から語るビジョンモード
  //   'report'  : 現状レポート寄り（現実的・整理してほしいとき）
  //   undefined : 通常ミラー
  //
  // Vision モードのときは、必ず vision 扱いにする。
  if (baseMode === 'vision') {
    (next as any).presentationKind = 'vision';
  } else if (baseMode === 'mirror') {
    // ミラーモードの中で「レポート寄り」にしたいときだけフラグを立てる。
    // 今はキーワードベースで軽く判定（UIボタンが出来たらそちらを優先）。
    const wantsReport =
      /レポート|状態整理|状況整理|まとめて|要約して|現状教えて/.test(text);

    if (wantsReport) {
      (next as any).presentationKind = 'report';
    } else {
      // 何もなければヒントは消しておく
      if ((next as any).presentationKind) {
        delete (next as any).presentationKind;
      }
    }
  } else if (baseMode === 'diagnosis') {
    // diagnosis 用のヒントは、今のところ不要なので何もしない
    // （ir診断は system プロンプト側のトリガーで制御）
    (next as any).presentationKind = 'diagnosis';
  }

  // 4) そのほか、ここで触らない情報はそのまま返す
  //    - intentLine / tLayerHint / selfAcceptance などは
  //      すでに orchestrator 側で詰められている。

  return next;
}
