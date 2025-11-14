'use client';

import React from 'react';
import type { IntentionForm, FineTuneInput } from './useIntentionPrompt';

type Props = {
  form: IntentionForm;
  ft: FineTuneInput;
};

export default function PreviewPanel({ form, ft }: Props) {
  return (
    <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 8 }}>
      <h3 style={{ marginBottom: 8 }}>仕様プレビュー</h3>

      <pre style={{ fontSize: 12 }}>
{JSON.stringify({ form, ft }, null, 2)}
      </pre>
    </div>
  );
}
