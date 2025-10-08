import StageThreePanel from '@/components/mui/StageThreePanel';
export default function Page() {
  // ここは実アプリの認証経由で user_code を取得して渡す
  return <StageThreePanel user_code="U-12345" />;
}
