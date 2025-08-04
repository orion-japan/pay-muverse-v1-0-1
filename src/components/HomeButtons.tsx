'use client';
import { useAuth } from '@/context/AuthContext';

export default function HomeButtons({ openLoginModal }: { openLoginModal: () => void }) {
  const { user } = useAuth();

  const handleClick = (name: string) => {
    if (!user) {
      // ✅ 未ログインならモーダルを開く
      openLoginModal();
      return;
    }
    console.log(`${name} ページに移動`);
    // ここに router.push(`/somepage`) など遷移処理を追加してもOK
  };

  return (
    <div className="flex gap-4 mt-4">
      <button onClick={() => handleClick('Mu_AI')} disabled={!user} className="btn">
        Mu_AI
      </button>
      <button onClick={() => handleClick('クレジット')} disabled={!user} className="btn">
        クレジット
      </button>
      <button onClick={() => handleClick('共鳴会')} disabled={!user} className="btn">
        共鳴会
      </button>
    </div>
  );
}
