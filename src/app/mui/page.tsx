// Server Component（'use client' は不要）
import './mui.css';
import MuiChat from '@/components/mui/MuiChat';

export default function Page() {
  return (
    <div className="mui-root">
      <MuiChat />
    </div>
  );
}
