'use client';

import React from 'react';

/**
 * WILLエンジンから来る nextStep と対応させた型
 * MessageList.tsx 内の meta.nextStep.options[] に合わせている
 */
export type IrosNextStepOption = {
  key: string;        // A / B / C / D など
  label: string;      // ボタンに表示する短い文
  description?: string; // （あれば）補足説明
};

/**
 * meta.nextStep.gear に対応
 * - safety       : 守り寄り（様子を見る・整える系）
 * - soft-rotate  : やわらかく方向転換
 * - full-rotate  : 大きく舵を切る
 */
export type IrosNextStepGear =
  | 'safety'
  | 'soft-rotate'
  | 'full-rotate'
  | string;

export type IrosButtonProps = {
  /** ボタン1個分の option 情報（MessageList.meta.nextStep.options[] そのまま） */
  option: IrosNextStepOption;

  /** meta.nextStep.gear を渡す想定（スタイルのニュアンスに利用できる） */
  gear?: IrosNextStepGear;

  /** true のあいだはクリック不可＆ローディング扱い */
  pending?: boolean;

  /** 強制的に押下不可にするフラグ */
  disabled?: boolean;

  /**
   * クリック時ハンドラ
   * - option ごと上位に渡す
   * - 実際の sendButtonEvent は上位コンポーネントで実装
   */
  onClick?: (option: IrosNextStepOption) => void;

  /** 追加で className を付けたい場合用（任意） */
  className?: string;
};

/**
 * Iros の「次の一歩」用ボタン
 * - MessageList.tsx の inline button と同じトーンの見た目
 * - gear によって少しだけ枠色を変えられるようにしてある
 */
const IrosButton: React.FC<IrosButtonProps> = (props) => {
  const {
    option,
    gear,
    pending = false,
    disabled = false,
    onClick,
    className,
  } = props;

  const isDisabled = disabled || pending;

  const handleClick = () => {
    if (isDisabled) return;
    onClick?.(option);
  };

  // gear によって枠線のニュアンスを少し変える（なくてもOKな程度）
  let borderColor = 'rgba(148,163,184,0.7)'; // デフォルト
  let background = 'linear-gradient(135deg, #f8fafc, #eef2ff)';

  if (gear === 'safety') {
    borderColor = 'rgba(59,130,246,0.75)'; // 青寄り
    background = 'linear-gradient(135deg, #eff6ff, #e0f2fe)';
  } else if (gear === 'soft-rotate') {
    borderColor = 'rgba(129,140,248,0.85)'; // 青紫
    background = 'linear-gradient(135deg, #eef2ff, #ede9fe)';
  } else if (gear === 'full-rotate') {
    borderColor = 'rgba(244,63,94,0.7)'; // 少し赤み
    background = 'linear-gradient(135deg, #fef2f2, #fee2e2)';
  }

  return (
    <button
      type="button"
      className={['iros-intent-button', className].filter(Boolean).join(' ')}
      onClick={handleClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={pending}
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        border: `1px solid ${borderColor}`,
        background,
        fontSize: 12,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        opacity: isDisabled ? 0.6 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        transition: 'transform 0.08s ease-out, box-shadow 0.08s ease-out',
      }}
    >
      {/* A / B / C などのキー表示 */}
      <span
        style={{
          fontWeight: 700,
          fontSize: 11,
          padding: '2px 6px',
          borderRadius: 999,
          background: 'rgba(15,23,42,0.06)',
        }}
      >
        {option.key}
      </span>

      {/* ラベル＋説明（説明はあればツールチップ的に title にも載せる） */}
      <span
        title={option.description || option.label}
        style={{
          fontWeight: 500,
        }}
      >
        {option.label}
      </span>

      {pending && (
        <span
          style={{
            fontSize: 10,
            marginLeft: 4,
          }}
        >
          …
        </span>
      )}
    </button>
  );
};

export default IrosButton;
