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
          ⚠️ You already have remaining credits
        </h2>
        <p className="text-sm text-gray-700">
          Current credits: <strong>{credit}</strong> left<br />
          If you continue, your plan will be <strong>overwritten</strong> with a new plan of (
          <strong>{tempPlan.credit}</strong> credits/month).<br />
          ※ Existing credits will not be carried over.
        </p>
        <div className="flex justify-end space-x-4">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button onClick={onConfirm} variant="destructive">
            OK (Overwrite & Continue)
          </Button>
        </div>
      </div>
    </div>
  );
}
