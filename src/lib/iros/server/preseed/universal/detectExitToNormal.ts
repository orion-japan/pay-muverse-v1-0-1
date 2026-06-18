export function detectExitToNormal(userText: string): boolean {
  const text = String(userText ?? '').trim();

  if (!text) return false;

  if (/^(別件|話変わる|話を変える|ところで|関係ない話|通常チャット|別の相談|違う話|それは置いといて|一旦戻って)/u.test(text)) {
    return true;
  }

  if (/(コード|PowerShell|typecheck|npm|エラー|実装|修正|ファイル|route\.ts|TypeScript|ビルド|デプロイ|Git)/iu.test(text)) {
    return true;
  }

  if (/(画像|動画|プロンプト|VEO|Seedance|Kling|花火|16:9|9:16)/iu.test(text)) {
    return true;
  }

  return false;
}
