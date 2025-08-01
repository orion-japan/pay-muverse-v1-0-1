// src/components/CardRegisterModal.tsx
'use client';

import CardForm, {
  /* CardForm 側で export した型を使う場合は↓ */
  // CardFormProps
} from '@components/forms/CardForm';

/**
 * モーダル自身の Props
 *  - isOpen     : モーダル表示フラグ
 *  - onClose    : 登録完了 or × ボタン押下で呼ばれるコールバック
 *  - userCode   : ユーザー識別子（CardForm にそのまま渡す）
 */
type Props = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;
};

export default function CardRegisterModal({
  isOpen,
  onClose,
  userCode,
}: Props) {
  /* 閉じているときは何も描画しない */
  if (!isOpen) return null;

  return (
    <div
      style={{
        backgroundColor: '#f9f9f9',
        padding: '1rem',
        borderRadius: 8,
        maxWidth: 520,
        margin: '0 auto',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
        カード登録モーダル
      </h1>

      {/* ✅ CardForm へ Props をそのままバケツリレー */}
      <CardForm userCode={userCode} onRegister={onClose} />
    </div>
  );
}
