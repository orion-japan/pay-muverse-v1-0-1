// sofia/lib/chat-messages.ts
// 画像アップロード機能が未実装なら、ここもスタブでOK
export async function uploadFile(_file: File, _userCode: string) {
    console.warn('[uploadFile] not implemented (stub)');
    return null as any;
  }
  