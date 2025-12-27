// src/lib/iros/iMode.ts

export type IModeResult = {
  enabled: boolean;
  reason?: string;
};

export function detectIMode(args: {
  text: string;
  force?: boolean;
}): IModeResult {
  // 明示的にONされた場合
  if (args.force) {
    return { enabled: true, reason: 'forced' };
  }

  const t = args.text || '';

  // 「意図を探している」「言語化できない」系トリガ
  if (
    /どうしたら|どうすれば|わからない|言葉にできない|掴めない|探してる|知りたい/.test(
      t,
    )
  ) {
    return { enabled: true, reason: 'intent-search' };
  }

  return { enabled: false };
}
