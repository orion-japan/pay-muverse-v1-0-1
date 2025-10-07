function shouldFilter(lines: string[]): boolean {
    let hit = 0;
    const tests = [
      /^(AI.?チャットちゃん?|LINE)$/i,
      /^自動で返信しています$/,
      /^検索$|^通話$|^ホーム$|^メニュー$/,
      /^既読$|^送信$/,
      /^\d{1,2}:\d{2}$/,
      /^—+$/,
    ];
    for (const raw of lines) {
      const s = raw.trim();
      if (!s) continue;
      if (tests.some((re) => re.test(s))) hit++;
    }
    return hit >= 2;
  }
  
  function isHeaderish(s: string): boolean {
    return (
      /^AI.?チャットちゃん?/.test(s) ||
      /^自動で返信しています$/.test(s) ||
      /^\d{1,2}:\d{2}$/.test(s) ||
      /^既読$/.test(s) ||
      /^送信$/.test(s)
    );
  }
  
  export function filterLineDecorationsAuto(src: string): string {
    const original = src.trim();
    const lines = original.split(/\r?\n/);
    if (!shouldFilter(lines)) return original;
  
    const drop = [
      /^AI.?チャットちゃん?$/i,
      /^自動で返信しています$/,
      /^検索$/, /^通話$/, /^ホーム$/, /^メニュー$/,
      /^既読$/, /^送信$/,
      /^\d{1,2}:\d{2}$/,
      /^—+$/,
    ];
    const out: string[] = [];
    for (const ln of lines) {
      const s = ln.trim();
      if (!s) { out.push(''); continue; }
      if (drop.some((re) => re.test(s))) continue;
      out.push(s.replace(/^…+/, '…').replace(/^\uFF5E+/, '～'));
    }
    while (out.length && isHeaderish(out[0])) out.shift();
  
    const filtered = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!filtered || filtered.length < Math.min(40, Math.floor(original.length * 0.3))) {
      // 削りすぎたので原文に戻す
      return original;
    }
    return filtered;
  }
  