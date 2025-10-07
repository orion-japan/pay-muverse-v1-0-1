'use client';
import React from 'react';

type Props = {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
};

export default function MuiComposer({
  placeholder,
  value,
  onChange,
  onSend,
  sending = false,
  textareaRef,
}: Props) {
  return (
    <div className="mui-composer">
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        // ← rows=3 をやめて初期行数を増やす
        rows={10}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // ← 入力に応じて高さを自動調整
        onInput={(e) => autoGrow(e.currentTarget)}
      />
      <div className="actions">
        <button
          className="primary"
          onClick={onSend}
          disabled={sending || !value.trim()}
        >
          送信
        </button>
      </div>
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  // 480px 上限で滑らかに伸縮
  el.style.height = Math.min(el.scrollHeight, 480) + 'px';
}
