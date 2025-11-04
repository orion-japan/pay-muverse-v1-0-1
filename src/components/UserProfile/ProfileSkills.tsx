'use client';
import React from 'react';
import type { Profile } from './index';
import './ProfileBox.css';

type Props = {
  profile: Profile;
  editable?: boolean;
  onChange?: (patch: Partial<Profile>) => void;
  asCard?: boolean; // ← 追加
};

const toCsv = (v?: string[] | string | null) => (Array.isArray(v) ? v.join(', ') : v || '');
const toArr = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export default function ProfileSkills({ profile: P, editable, onChange, asCard }: Props) {
  const arrayField = (k: keyof Profile, ph: string) =>
    editable ? (
      <input
        className="mu-input"
        value={toCsv(P[k] as any)}
        placeholder={ph}
        onChange={(e) => onChange?.({ [k]: toArr(e.target.value) })}
      />
    ) : (
      <div className="plain">{toCsv(P[k] as any) || '—'}</div>
    );

  const Wrapper: any = asCard ? 'div' : React.Fragment;
  const wrapProps = asCard ? { className: 'mu-card' } : {};

  return (
    <Wrapper {...wrapProps}>
      <h3>スキル / 興味 / 言語</h3>
      <div className="grid-3">
        <label>skills（,区切り）{arrayField('skills', 'design, nextjs, supabase')}</label>
        <label>interests（,区切り）{arrayField('interests', 'ai, resonance, art')}</label>
        <label>languages（,区切り）{arrayField('languages', 'ja, en')}</label>
      </div>
      <label>activity_area（,区切り）{arrayField('activity_area', 'tokyo, yokohama')}</label>
    </Wrapper>
  );
}
