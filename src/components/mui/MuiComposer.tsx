'use client';
import React, { useRef, useEffect } from 'react';

type Props = {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  /** ← 追加: OCR直後などでベース高さを少し増やしたい時に使う */
  expanded?: boolean;
};

export default function MuiComposer({
  placeholder,
  value,
  onChange,
  onSend,
  sending = false,
  textareaRef,
  expanded = false, // ← 追加
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const h = el.offsetHeight || 0;
      document.documentElement.style.setProperty('--composer-h', `${h}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const onWinResize = () => update();
    window.addEventListener('resize', onWinResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
    };
  }, []);

  // value/expanded が変わった時も高さ追従
  useEffect(() => {
    if (textareaRef?.current) autoGrow(textareaRef.current);
  }, [value, expanded, textareaRef]);

  // expanded に応じてベース行数を変える（autoGrow は el.rows を見る）
  const baseRows = expanded ? 6 : 3;

  return (
    <div ref={rootRef} className="mui-composer">
      <div className="mui-composer-inner">
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          rows={baseRows}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onInput={(e) => autoGrow(e.currentTarget)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              if (composingRef.current) return;
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          className="primary send-btn"
          onClick={onSend}
          disabled={sending || !value.trim()}
          aria-label="送信"
        >
          送信
        </button>
      </div>
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement) {
  const style = window.getComputedStyle(el);
  const lineH = parseFloat(style.lineHeight || '20') || 20;
  const paddingY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
  const minH = Math.round(lineH * (el.rows || 3) + paddingY);
  el.style.height = 'auto';
  const next = Math.min(el.scrollHeight, 240);
  el.style.height = Math.max(next, minH) + 'px';
}
