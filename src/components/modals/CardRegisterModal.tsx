'use client';

import { useSearchParams } from 'next/navigation';
import GenericModal from './GenericModal';
import CardForm from '../forms/CardForm';

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function CardRegisterModal({ isOpen, onClose }: Props) {
  const searchParams = useSearchParams();
  const userCode = searchParams.get('user') || '';

  console.log('📦 CardRegisterModal がレンダリングされました');
  console.log('🧾 userCode:', userCode);

  if (!userCode) {
    return (
      <GenericModal isOpen={isOpen} onClose={onClose} title="エラー">
        <p>ユーザー情報が見つかりませんでした。</p>
      </GenericModal>
    );
  }

  return (
    <GenericModal isOpen={isOpen} onClose={onClose} title="カード登録">
      <CardForm userCode={userCode} />
    </GenericModal>
  );
}
