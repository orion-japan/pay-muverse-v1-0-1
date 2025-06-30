// 完全に表示だけ
export default function ThanksPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-2xl mb-4">登録が完了しました！</h1>
      <p>以下よりアプリにお入りください</p>
      <a
        href="https://muverse.jp/"
        className="text-blue-600 underline mt-2"
      >
        https://muverse.jp/
      </a>
    </main>
  );
}
