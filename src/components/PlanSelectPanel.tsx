import React, { useState } from 'react';
import PlanSelectModal from './PlanSelectModal';

type Plan = {
  name: string;
  icon: string;  // ← アイコン追加
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

const plans: Plan[] = [
  {
    name: 'Regular',
    icon: '🌱',
    plan_type: 'regular',
    credit: 45,
    price: 990,
  },
  {
    name: 'Premium',
    icon: '🌟',
    plan_type: 'premium',
    credit: 200,
    price: 3300,
  },
  {
    name: 'Master',
    icon: '🏆',
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
    <div className="plan-panel">
     

      {plans.map((plan) => (
        <div
          key={plan.plan_type}
          className={`plan-card ${selectedPlan?.plan_type === plan.plan_type ? 'selected' : ''}`}
        >
          <div className="plan-header">
            <h3>
              <span className="plan-icon">{plan.icon}</span> {plan.name} プラン
            </h3>
            {selectedPlan?.plan_type === plan.plan_type && (
              <span className="selected-badge">✅ 選択中</span>
            )}
          </div>

          <p className="plan-text">💰 <span className="font-bold">料金:</span> ¥{plan.price.toLocaleString()} / 月</p>
          <p className="plan-text">⚡ <span className="font-bold">クレジット:</span> {plan.credit} / 月</p>

          <button
            className={`plan-btn ${cardRegistered ? 'active' : 'disabled'}`}
            onClick={() => handleSelectPlan(plan)}
            disabled={!cardRegistered}
          >
            {cardRegistered
              ? `${plan.name} プランを選択`
              : 'カードを登録してください'}
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
