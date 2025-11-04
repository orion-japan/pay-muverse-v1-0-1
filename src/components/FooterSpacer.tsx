// src/components/FooterSpacer.tsx
'use client';

export default function FooterSpacer({ disabled }: { disabled?: boolean }) {
  if (disabled) return null;
  return (
    <div id="mu-footer-spacer" aria-hidden style={{ height: 'var(--footer-safe-pad, 72px)' }} />
  );
}
