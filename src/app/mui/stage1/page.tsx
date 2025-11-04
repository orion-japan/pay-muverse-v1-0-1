// src/app/mui/stage1/page.tsx
export const dynamic = 'force-dynamic';

import StageOnePanel from '@/components/mui/StageOnePanel';
// ↓ フォルダ配下にあるためフルパスで
import '@/components/mui/StageOnePanel/StageOnePanel.css';

export default async function Page({
  searchParams,
}: {
  // Next.js 15: Promise で受け取る
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const conv = Array.isArray(sp.conv) ? sp.conv[0] : (sp.conv ?? null);

  // user_code は CSR 側で解決する想定なので固定でOK
  const user_code = 'ANON';

  return <StageOnePanel user_code={user_code} conv={conv} />;
}
