'use client';

import React from 'react';

/**
 * WILLエンジンから来る nextStep と対応させた型
 * MessageList.tsx 内の meta.nextStep.options[] に合わせている
 *
 * ✅ 重要：
 * - id を持たせる（= choiceId）
 * - key は表示用（A/B/C 等）として残してOK
 */
export type IrosNextStepOption = {
  /** ✅ ボタン選択ID（例: soft_shift_future / it_from_t など） */
  id: string;

  /** 表示上のキー（A / B / C / D 等）。無ければUI側で非表示でもOK */
  key?: string;

  /** ボタンに表示する短い文 */
  label: string;

  /** （あれば）補足説明 */
  description?: string;
};

/**
 * meta.nextStep.gear に対応
 */
export type IrosNextStepGear =
  | 'safety'
  | 'soft-rotate'
  | 'full-rotate'
  | 'it-demo'
  | string;

export type IrosButtonProps = {
  /** ボタン1個分の option 情報 */
  option: IrosNextStepOption;

  /** meta.nextStep.gear を渡す想定 */
  gear?: IrosNextStepGear;

  /** true のあいだはクリック不可＆ローディング扱い */
  pending?: boolean;

  /** 強制的に押下不可にするフラグ */
  disabled?: boolean;

  /**
   * クリック時ハンドラ
   * - option を上位に渡す（✅ id を含む）
   */
  onClick?: (option: IrosNextStepOption) => void;

  /** 追加で className */
  className?: string;
};

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

  // gear によって枠線のニュアンスを少し変える
  let borderColor = 'rgba(148,163,184,0.7)';
  let background = 'linear-gradient(135deg, #f8fafc, #eef2ff)';

  if (gear === 'safety') {
    borderColor = 'rgba(59,130,246,0.75)';
    background = 'linear-gradient(135deg, #eff6ff, #e0f2fe)';
  } else if (gear === 'soft-rotate') {
    borderColor = 'rgba(129,140,248,0.85)';
    background = 'linear-gradient(135deg, #eef2ff, #ede9fe)';
  } else if (gear === 'full-rotate') {
    borderColor = 'rgba(244,63,94,0.7)';
    background = 'linear-gradient(135deg, #fef2f2, #fee2e2)';
  } else if (gear === 'it-demo') {
    borderColor = 'rgba(16,185,129,0.75)'; // ほんのり緑
    background = 'linear-gradient(135deg, #ecfdf5, #d1fae5)';
  }

  const keyText = (option.key ?? '').trim();
  const showKey = keyText.length > 0;

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
        gap: 6,
        transition: 'transform 0.08s ease-out, box-shadow 0.08s ease-out',
      }}
      title={option.description || option.label}
      data-choice-id={option.id} // ✅ デバッグしやすい
    >
      {/* A / B / C など（任意） */}
      {showKey && (
        <span
          style={{
            fontWeight: 700,
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 999,
            background: 'rgba(15,23,42,0.06)',
          }}
        >
          {keyText}
        </span>
      )}

      {/* ラベル */}
      <span style={{ fontWeight: 500 }}>{option.label}</span>

      {pending && (
        <span style={{ fontSize: 10, marginLeft: 4 }}>
          …
        </span>
      )}
    </button>
  );
};

export default IrosButton;
