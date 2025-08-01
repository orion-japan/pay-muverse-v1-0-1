'use client';

import CardForm from '../forms/CardForm';

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function CardRegisterModal({ isOpen, onClose }: Props) {
  const userCode = '仮のuserCode'; // ✅ 本番は useSearchParams などで取得

  if (!isOpen) return null;

  return (
    <div style={{ backgroundColor: '#f9f9f9', padding: '1rem', borderRadius: 8 }}>
      <h1>📥 カード登録モーダル</h1>

      {/* ✅ CardForm に Props が適用されているので、型エラーが出ない */}
      <CardForm userCode={userCode} onRegister={onClose} />
    </div>
  );
}
