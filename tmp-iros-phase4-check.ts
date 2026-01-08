import { mergeHistoryForTurn } from './src/lib/iros/server/historyX';

function main() {
  // dbHistory は “跨ぎ” の想定（今回は空でもOK）
  const dbHistory: any[] = [];

  // turnHistory は “同一会話” の想定（assistant混入を意図的に作る）
  const turnHistory: any[] = [
    { role: 'user', content: '売上目標に満たなくて焦ってる' },

    // ✅ banned assistant テンプレ（除外されるべき）
    { role: 'assistant', content: 'まずは紙に書き出して整理されるかもしれません。' },

    // ✅ bannedに該当しない assistant（残ってよい）
    { role: 'assistant', content: '受け取った。🪔 いまの一点だけ残す。' },

    // ✅ 沈黙（除外されるべき）
    { role: 'assistant', content: '…' },
  ];

  const merged = mergeHistoryForTurn({
    dbHistory,
    turnHistory,
    maxTotal: 80,
  });

  const roleCounts = merged.reduce((a: Record<string, number>, m: any) => {
    const role = String(m?.role ?? 'unknown');
    a[role] = (a[role] || 0) + 1;
    return a;
  }, {});

  console.log('mergedLen:', merged.length);
  console.log('roleCounts:', roleCounts);

  const assistantTexts = merged
    .filter((m: any) => String(m?.role) === 'assistant')
    .map((m: any) => String(m?.content ?? m?.text ?? ''));

  console.log('assistantTexts:', assistantTexts);
}

main();
