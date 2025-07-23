'use client';

import React from 'react';
import { Button } from '@/components/ui/button';

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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white space-y-4 max-w-md w-full p-6 rounded-xl shadow-xl">
        <h2 className="text-xl font-bold text-yellow-600 text-center">
          ⚠️ クレジット残があります
        </h2>
        <p className="text-sm text-gray-700">
          現在のクレジット残：<strong>{credit}</strong> 回<br />
          このまま購入すると、新しいプラン（
          <strong>{tempPlan.credit}</strong> 回）に
          <strong>上書き</strong>されます。<br />
          ※ 残っているクレジットは引き継がれません。
        </p>
        <div className="flex justify-end space-x-4">
          <Button onClick={onCancel} variant="ghost">
            キャンセル
          </Button>
          <Button onClick={onConfirm} variant="destructive">
            OK（上書きして続行）
          </Button>
        </div>
      </div>
    </div>
  );
}
