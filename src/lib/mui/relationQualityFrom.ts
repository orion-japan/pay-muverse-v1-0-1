// src/lib/mui/relationQualityFrom.ts

export function relationQualityFrom(text: string): '上昇' | '停滞' | '低下' {
  const up = /(感謝|安心|尊重|合意|理解)/g.test(text);
  const down = /(不信|苛立ち|沈黙|拒絶|冷たい)/g.test(text);
  if (up && !down) return '上昇';
  if (down && !up) return '低下';
  return '停滞';
}
