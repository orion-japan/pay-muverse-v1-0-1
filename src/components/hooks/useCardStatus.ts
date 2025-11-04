import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export function useCardStatus(userId: string) {
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      const { data, error } = await supabase
        .from('users')
        .select('card_registered') // ←カラム名はあなたのDBに合わせて修正
        .eq('user_code', userId)
        .single();

      if (error) {
        console.error('カード登録状況の取得に失敗:', error);
        setIsRegistered(false);
      } else {
        setIsRegistered(data?.card_registered === true);
      }
    };

    fetchStatus();
  }, [userId]);

  return isRegistered;
}
