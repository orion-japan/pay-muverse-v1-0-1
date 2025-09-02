// sofia/lib/delete-conversation.ts
// いまの /api/sofia には DELETE/rename が無いので、成功 false のスタブ。
// APIを増やすまで UI から呼ばれても安全に抜ける。
export async function deleteConversation(_id: string, _userCode: string): Promise<boolean> {
    console.warn('[deleteConversation] not implemented on /api/sofia');
    return false;
  }
  