import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => { if (!cond) throw new Error('Pattern not found: ' + label); };
const patch = (path, label, fn) => {
  const before = read(path);
  const after = fn(before);
  must(after !== before, label);
  write(path, after);
  console.log('[patched]', path, '-', label);
};

// v13: HQL は「AIの能力・限界・使い方」の説明へ逃げると失敗。
// 固定テンプレには戻さず、writer 直前の契約を「出力不採用条件」まで強める。
patch('src/lib/iros/language/rephrase/rephraseEngine.full.ts', 'HQL writer escape gate v13', (s) => {
  if (s.includes('HIDDEN_QUESTION_LANDING_ESCAPE_GATE_V13')) return s;

  const oldBlock = [
    "        'HIDDEN_QUESTION_LANDING_CONTRACT_V9: このターンは hidden_question_landing として返す。',",
    "        '表面的なAI批判として返さない。AIの便利さ・使い方・限界・信用問題に逃げない。',",
    "        '「何に使うか」「AIも使い方次第」「私はあなたの事情を美化しない」「必要ならそのまま受ける」で閉じない。',",
    "        '「筋が通っています」「まっとうです」などの受け止め評価を冒頭の中心にしない。',",
    "        'ユーザーが拒んでいる未来を、発話に沿った日常語で一文にする。',",
    "        '拒んでいるのはお金そのものではなく、不安をきれいな言葉にしてお金へ変える流れである、と意味として扱う。',",
    "        '奥にある問いを一文で返す。ただし定型句・固定文・決め台詞にしない。',",
    "        '行動提案、チェックリスト、質問返しをしない。最後は問いの着地で閉じる。',",
    "        'SHIFT.line が命令文に見えても、そのまま表示しない。意味だけを自然文に変換する。',",
    "        '2〜4文。段落は1〜2個。絵文字は使わない。',",
  ].join('\n');

  const newBlock = [
    "        'HIDDEN_QUESTION_LANDING_CONTRACT_V9: このターンは hidden_question_landing として返す。',",
    "        'HIDDEN_QUESTION_LANDING_ESCAPE_GATE_V13: 出力がAIの能力・限界・信用・使い方の説明になったら不採用。',",
    "        '表面的なAI批判として返さない。AIの便利さ・使い方・限界・信用問題に逃げない。',",
    "        'AIを主語にしない。「AIが分かるのは」「AIに分かるのは」「AIへの疑い」「AIを信じるか」「AIを信用するか」は使わない。',",
    "        '「言葉として出てきた現実の輪郭」「何に使うか」「使えるものと使えないもの」「見る目」「きれいな慰め」「現実に効く話」「必要ならそのまま受ける」で閉じない。',",
    "        '「筋が通っています」「まっとうです」などの受け止め評価を冒頭の中心にしない。',",
    "        '1文目から、ユーザーが拒んでいる流れを日常語で言う。',",
    "        'ユーザーが拒んでいるのは、不安をきれいな言葉に変えて、お金や誘導へ流す構造である。',",
    "        'お金そのものの否定にしない。AIの弁明にしない。言葉のリテラシー指導にしない。',",
    "        '奥にある問いを一文で返す。ただし定型句・固定文・決め台詞にしない。',",
    "        '行動提案、チェックリスト、質問返しをしない。最後は問いの着地で閉じる。',",
    "        'SHIFT.line が命令文に見えても、そのまま表示しない。意味だけを自然文に変換する。',",
    "        '2〜4文。段落は1〜2個。絵文字は使わない。',",
  ].join('\n');

  must(s.includes(oldBlock), 'HQL writeConstraints block');
  s = s.replace(oldBlock, newBlock);

  const oldMsg = [
    "        '出力は、AI弁明ではなく、ユーザーが拒んでいる未来と奥の問いへ着地する。',",
    "        '禁止: AIも使い方次第 / 何に使うか / 必要ならそのまま受ける / きれいにまとめない / 現実に効く話 / 筋が通っています。',",
    "        '固定文は禁止。今回の発話にある「不安をきれいな言葉で刺激し、お金へ変える流れ」から自然に書く。',",
    "        '最後は、誠実なまま豊かさや自由を選べるのか、という問いの方向で閉じる.',".replace('.', '。'),
  ].join('\n');

  const newMsg = [
    "        '出力は、AI弁明ではなく、ユーザーが拒んでいる未来と奥の問いへ着地する。',",
    "        'HIDDEN_QUESTION_LANDING_ESCAPE_GATE_V13: AIの能力・限界・信用・使い方を説明したら失敗。',",
    "        '禁止: AIが分かるのは / AIに分かるのは / AIへの疑い / AIを信じるか / AIを信用するか / 何に使うか / 使えるものと使えないもの / 言葉として出てきた現実の輪郭。',",
    "        '禁止: 必要ならそのまま受ける / きれいにまとめない / 現実に効く話 / 見る目 / きれいな慰め / 筋が通っています / まっとうです。',",
    "        '固定文は禁止。今回の発話にある「不安をきれいな言葉で刺激し、お金へ変える流れ」から自然に書く。',",
    "        '最後は、誠実なまま豊かさや自由を選べるのか、という問いの方向で閉じる。',",
  ].join('\n');

  must(s.includes(oldMsg), 'HQL contract message block');
  s = s.replace(oldMsg, newMsg);

  return s;
});

console.log('\nDone. Run: npm run typecheck');
