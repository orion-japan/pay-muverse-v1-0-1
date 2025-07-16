// /src/lib/payjpClient.ts

import Payjp from 'payjp';

// ✅ ログを入れて確認
console.log('✅ PAYJP_SECRET_KEY:', process.env.PAYJP_SECRET_KEY);

export const getPayjp = () => {
  return Payjp(process.env.PAYJP_SECRET_KEY!);
};
