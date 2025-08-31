// まだ DELETE エンドポイントが無い前提の no-op 実装。
// UI 側の「会話を消す」操作をエラー無しに通すだけ。

export async function deleteConversation(_convId: string, _userId: string): Promise<boolean> {
    // 必要ならここで /api/sofia に空メッセージで上書き等を実装
    return true;
  }
  