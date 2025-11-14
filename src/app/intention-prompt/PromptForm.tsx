'use client';

import React from 'react';
import type { IntentionForm } from './useIntentionPrompt';
import * as s from './style';

type Props = {
  form: IntentionForm;
  onChange: <K extends keyof IntentionForm>(key: K, value: IntentionForm[K]) => void;
};

export default function PromptForm({ form, onChange }: Props) {
  const update =
    (key: keyof IntentionForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      onChange(key as any, e.target.value);
    };

  return (
    <div style={s.formCard}>
      <h2 style={s.h2}>祈りフォーム</h2>

      <label style={s.formLabel}>
        名前
        <input style={s.formInput} value={form.name} onChange={update('name')} />
      </label>

      <label style={s.formLabel}>
        対象
        <input style={s.formInput} value={form.target} onChange={update('target')} />
      </label>

      <label style={s.formLabel}>
        願い
        <textarea style={s.formTextarea} value={form.desire} onChange={update('desire')} />
      </label>

      <label style={s.formLabel}>
        理由
        <textarea style={s.formTextarea} value={form.reason} onChange={update('reason')} />
      </label>

      <label style={s.formLabel}>
        見たい世界
        <textarea style={s.formTextarea} value={form.vision} onChange={update('vision')} />
      </label>

      <label style={s.formLabel}>
        心の状態（mood）
        <select style={s.formSelect} value={form.mood} onChange={update('mood')}>
          <option value="静けさ">静けさ</option>
          <option value="希望">希望</option>
          <option value="情熱">情熱</option>
          <option value="不安">不安</option>
          <option value="迷い">迷い</option>
          <option value="感謝">感謝</option>
        </select>
      </label>

      <label style={s.formLabel}>
        公開設定
        <select style={s.formSelect} value={form.visibility} onChange={update('visibility')}>
          <option value="公開">公開</option>
          <option value="非公開">非公開</option>
        </select>
      </label>

      <label style={s.formLabel}>
        季節
        <input style={s.formInput} value={form.season} onChange={update('season')} />
      </label>

      <label style={s.formLabel}>
        タイミング
        <input style={s.formInput} value={form.timing} onChange={update('timing')} />
      </label>
    </div>
  );
}
