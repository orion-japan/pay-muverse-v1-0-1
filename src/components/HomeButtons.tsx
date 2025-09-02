'use client';
import { useAuth } from '@/context/AuthContext';
import SafeNavTile from '@/components/SafeNavTile';

export default function HomeButtons({ openLoginModal }: { openLoginModal: () => void }) {
  const { user, planStatus, loading: authLoading, ...rest } = useAuth() as any;
  const clickType = rest.clickType ?? rest.click_type ?? null;

  // 認証読み込み中は必ず false（瞬間クリック封じ）
  const isSofiaAllowed =
    !authLoading &&
    !!user &&
    ((planStatus === 'master' || planStatus === 'admin') ||
     (clickType === 'master' || clickType === 'admin'));

  return (
    <div className="tiles-wrap">
      {/* …他タイル… */}
      <SafeNavTile
        allowed={isSofiaAllowed}
        href="/sofia"
        className="btn"             // 既存の見た目クラスはそのまま
        onBlockedClick={() => { if (!user) openLoginModal(); }}
      >
        Sofia
      </SafeNavTile>
    </div>
  );
}
