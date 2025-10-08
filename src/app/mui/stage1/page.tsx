// src/app/mui/stage1/page.tsx
import StageOnePanel from '@/components/mui/StageOnePanel';

export default function Page() {
  const user_code = 'U-12345'; // 実際はセッションやプロフィールから取得
  return <StageOnePanel user_code={user_code} />;
}
