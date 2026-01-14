// tmp_renderGateway_check.ts
import { renderGatewayAsReply } from './src/lib/iros/language/renderGateway';

function assertEq(title: string, got: string, expected: string) {
  const ok = got === expected;
  console.log('\n===', title, '===');
  if (!ok) {
    console.log('❌ FAIL');
    console.log('--- GOT ---\n' + got);
    console.log('--- EXP ---\n' + expected);
    process.exitCode = 1;
  } else {
    console.log('✅ PASS');
    // 目視したいならコメント外す
    // console.log('OUT:\n' + got);
  }
}

function runCase(
  title: string,
  args: any,
  expected: string,
  opts?: { showMeta?: boolean }
) {
  const r = renderGatewayAsReply(args);
  if (opts?.showMeta) {
    console.log('\n[META]', title, r.meta);
  }
  assertEq(title, r.content, expected);
}

// ─────────────────────────────────────────────────────────────
// A) 文中🪔は残す（inline は消さない）
//    ※末尾の🪔は「単独行」なら正規化対象になり得るので、ここは期待値を明確に。
//    期待：文中の🪔はそのまま、末尾は “単独行🪔” なら 1つに正規化されてもOK。
//    → あなたの現行仕様が「末尾1つ正規化」なら、この期待値に合わせる。
runCase(
  'A: inline 🪔 stays; trailing standalone normalizes to one at end',
  {
    content: 'OK。🪔\n次は一手だけ。\n🪔',
    extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'FINAL' } },
    maxLines: 8,
  },
  // 期待値（末尾🪔は単独行なので、正規化後も末尾に1つ）
  'OK。🪔\n次は一手だけ。\n🪔'
);

// B) 🪔単独行が複数 → 末尾に1つに正規化
runCase(
  'B: many standalone 🪔 normalize to one at end',
  {
    content: '🪔\n一点だけを残す。\n🪔\n呼吸を戻す。\n🪔',
    extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'FINAL' } },
    maxLines: 8,
  },
  // 期待：先頭の単独🪔や途中の単独🪔は消えて、末尾に1つだけ残る
  '一点だけを残す。\n呼吸を戻す。\n🪔'
);

// C) SCAFFOLD: 内部ラベル除去は起きるか、🪔はどう扱うか（仕様を固定する）
//    ここが「SCAFFOLDでも常に🪔」になってると、毎回🪔が出る原因になる。
//    期待：FRAME= などは落ちる。末尾🪔は “もともと単独行なら” 残る/残さないを仕様で決めて固定。
//    ↓ ここでは「SCAFFOLDでは🪔を強制しない」想定の期待値にしている。
//    ※もし現行が違うなら expected を合わせてから直す。
runCase(
  'C: scaffold strips internals; does NOT force 🪔',
  {
    content: 'writer hint: ...\nFRAME=R\n一点だけを残す。\n🪔',
    extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'SCAFFOLD' } },
    maxLines: 4,
  },
  // 期待：FRAME=R は除去。末尾🪔は「SCAFFOLDでは強制しない」なら消す。
  // （= “🪔は会話終端フラグのときだけ renderGateway が足す” の設計に寄せる）
  'writer hint: ...\n一点だけを残す。'
);

// D) 「会話を閉じるときだけ🪔」のテスト（これが最重要）
//    ※ここはあなたの meta/extra の実装に合わせてキーを置き換えてOK。
//    例：extra.renderClose === true のようなフラグで renderGateway が🪔を付ける、等。
runCase(
  'D: close-flag adds 🪔 (only when explicitly closing)',
  {
    content: '今日はここまで。',
    extra: {
      renderEngine: true,
      framePlan: { slotPlanPolicy: 'FINAL' },
      // ★あなたの実装に合わせてここを変える（例）
      // close: true,
      // conversationClose: true,
      // explicitClose: true,
      explicitClose: true,
    },
    maxLines: 8,
  },
  '今日はここまで。\n🪔',
  { showMeta: true }
);

if (process.exitCode === 1) {
  console.log('\nOne or more cases failed.');
} else {
  console.log('\nAll cases passed.');
}
