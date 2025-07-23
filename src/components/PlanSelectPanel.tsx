'use client';

import React, { useState } from 'react';
import PlanSelectModal from './PlanSelectModal';

type Plan = {
  name: string;
  plan_type: string;
  credit: number;
  price: number;
};

type Props = {
  userCode: string;
  cardRegistered: boolean;
  onPlanSelected: (plan: Plan) => void;
  userCredit: number;
};

// ✅ 提供プランの一覧（plan_type ベースに統一）
const plans: Plan[] = [
  {
    name: 'ライトプラン（regular）',
    plan_type: 'regular',
    credit: 45,
    price: 990,
  },
  {
    name: 'スタンダード（premium）',
    plan_type: 'premium',
    credit: 200,
    price: 3300,
  },
  {
    name: 'プロフェッショナル（master）',
    plan_type: 'master',
    credit: 1500,
    price: 16500,
  },
];

export default function PlanSelectPanel({
  userCode,
  cardRegistered,
  onPlanSelected,
  userCredit,
}: Props) {
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [tempPlan, setTempPlan] = useState<Plan | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const handleSelectPlan = (plan: Plan) => {
    console.log('🟡 プラン選択:', plan.plan_type);

    if (userCredit === 0) {
      setSelectedPlan(plan);
      onPlanSelected(plan);
    } else {
      setTempPlan(plan);
      setShowConfirmModal(true);
    }
  };

  const confirmOverwrite = () => {
    if (tempPlan) {
      setSelectedPlan(tempPlan);
      onPlanSelected(tempPlan);
    }
    setShowConfirmModal(false);
    setTempPlan(null);
  };

  const cancelOverwrite = () => {
    setTempPlan(null);
    setShowConfirmModal(false);
  };

  return (
    <div className="space-y-4 max-w-md w-full bg-white p-6 rounded-xl shadow-xl">
      <h2 className="text-2xl font-bold mb-4 text-center">プランを選んで決済</h2>

      {plans.map((plan) => (
        <div
          key={plan.plan_type}
          className={`border p-4 rounded shadow bg-white transition ${
            selectedPlan?.plan_type === plan.plan_type
              ? 'border-blue-600 ring-2 ring-blue-400'
              : 'border-gray-300'
          }`}
        >
          <p className="font-bold">{plan.name}</p>
          <p>月額: ¥{plan.price.toLocaleString()}</p>
          <p>付与クレジット: {plan.credit} 回 / 月</p>
          <button
            className="mt-2 px-4 py-1 bg-blue-600 text-white rounded disabled:opacity-50"
            onClick={() => handleSelectPlan(plan)}
            disabled={!cardRegistered}
          >
            このプランを選択
          </button>
        </div>
      ))}

      <PlanSelectModal
        visible={showConfirmModal}
        credit={userCredit}
        tempPlan={tempPlan}
        onConfirm={confirmOverwrite}
        onCancel={cancelOverwrite}
      />
    </div>
  );
}
