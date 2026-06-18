function pickContains(source: string, phrase: string): boolean {
  return String(source ?? '').includes(phrase);
}

export function buildScreenshotDiagnosisDirectReply(args: {
  displayId: number;
  diagnosisText: string;
}): string {
  const displayId = Math.trunc(args.displayId);
  const source = String(args.diagnosisText ?? '').trim();

  const hasHope = pickContains(source, '最近希望がない');
  const hasSelfBlame = pickContains(source, '約束守れなかったから私が悪い');
  const hasNotThat = pickContains(source, 'そう言う事じゃない');
  const hasMismatch = pickContains(source, 'すれ違いの継続');
  const hasTimeGap =
    pickContains(source, '9:16') ||
    pickContains(source, '11:41') ||
    pickContains(source, '9：16') ||
    pickContains(source, '11：41');

  const lines: string[] = [];

  lines.push(
    `スクショ診断ID:${displayId}の続きとして見ると、中心は「気持ちを共有したい流れ」と「原因確認・自己責任化に寄ってしまう流れ」のズレです。`
  );

  if (hasHope || hasSelfBlame) {
    lines.push(
      'あなたが「最近希望がない」と出したところに対して、相手は気持ちそのものを受け止めるより、原因を確認する方向に入り、その後「約束守れなかったから私が悪い」という自己非難へ寄っています。'
    );
  }

  if (hasNotThat) {
    lines.push(
      'だから、あなたの「そう言う事じゃない」は、相手を責めたいというより、その受け取り方ではない、と止めている反応に見えます。'
    );
  }

  if (hasMismatch) {
    lines.push(
      'ここで起きているのは、単なる言い合いではなく、診断に出ていた通り「すれ違いの継続」です。'
    );
  }

  if (hasTimeGap) {
    lines.push(
      '9:16から11:41の空白も、話が一度止まってから「会えなかったこと」に引き戻されている流れとして見えます。'
    );
  }

  if (lines.length <= 1) {
    const head = source.replace(/\s+/g, ' ').slice(0, 260);
    lines.push(
      `この診断本文の中では、次の流れが正本です。${head}`
    );
  }

  return lines.join('\n\n').trim();
}
