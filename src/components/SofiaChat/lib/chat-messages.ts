// 画像アップロードは未接続のためローカル ID を返すスタブ

export async function uploadFile(file: File, _userId: string) {
    // ここで実際のアップロードを実装する場合は Supabase Storage などに繋ぐ
    const id = `local-${Date.now()}-${file.name}`;
    return { id };
  }
  