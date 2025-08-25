// src/components/PlanSelectModal.tsx
'use client';

import React from 'react';
import GenericModal from './modals/GenericModal';

type TempPlan = {
  name: string;
  plan_type: string;
  credit: number;
  price: number;
};

type Props = {
  visible: boolean;
  credit: number;
  tempPlan: TempPlan | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function PlanSelectModal({
  visible,
  credit,
  tempPlan,
  onConfirm,
  onCancel,
}: Props) {
  if (!visible || !tempPlan) return null;

  return (
    <GenericModal
      isOpen={visible}
      title={
        <>
          ⚠️ まだ利用可能な<br />クレジットが
          <br />
          残っています
        </>
      }   // ← ここに } を忘れず閉じる
      onCancel={onCancel}
      onConfirm={onConfirm}
      confirmLabel="OK（上書きして進む）"
      cancelLabel="キャンセル"
    >
      <p className="modal-message">
        現在のクレジット: <strong>{credit}</strong><br />
        このまま進むと、<br /><strong>{tempPlan.credit}</strong> クレジット/月 の<br />新しいプランに<br />
        <span className="highlight"> 上書き </span>されます。
      </p>
      <p className="modal-note">
        ※ 残っているクレジットは<br />引き継がれません。
      </p>
    </GenericModal>
  );
}