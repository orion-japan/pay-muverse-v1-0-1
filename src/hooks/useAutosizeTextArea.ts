'use client';
import { useLayoutEffect } from 'react';

export function useAutosizeTextArea(el: HTMLTextAreaElement | null, value: string) {
  useLayoutEffect(() => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [el, value]);
}
