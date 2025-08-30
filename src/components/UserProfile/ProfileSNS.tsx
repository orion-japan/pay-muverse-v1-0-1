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

const makeLink = (type: 'x'|'instagram'|'facebook'|'linkedin'|'youtube'|'web', raw?: string) => {
  if (!raw) return <div className="plain">—</div>;
  const v = raw.trim();
  if (!v) return <div className="plain">—</div>;
  if (/^https?:\/\//i.test(v)) return <a href={v} target="_blank" rel="noopener noreferrer" className="mu-link">{v}</a>;
  const handle = v.replace(/^@/, '');
  const url =
    type==='x' ? `https://x.com/${handle}` :
    type==='instagram' ? `https://instagram.com/${handle}` :
    type==='facebook' ? `https://facebook.com/${handle}` :
    type==='linkedin' ? (/^company\//i.test(handle) ? `https://www.linkedin.com/${handle}` : `https://www.linkedin.com/in/${handle}`) :
    type==='youtube' ? (handle.startsWith('channel/') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/@${handle}`) :
    `https://${handle}`;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="mu-link">{url}</a>;
};

export default function ProfileSNS({ profile: P, editable, onChange, asCard }: Props) {
  const text = (k: keyof Profile, ph: string) =>
    editable
      ? <input className="mu-input" value={(P[k] as any) ?? ''} placeholder={ph}
               onChange={(e) => onChange?.({ [k]: e.target.value })} />
      : makeLink(k as any, (P[k] as any) ?? '');

  const Wrapper: any = asCard ? 'div' : React.Fragment;
  const wrapProps = asCard ? { className: 'mu-card' } : {};

  return (
    <Wrapper {...wrapProps}>
      <h3>SNS / Link</h3>
      <div className="grid-3">
        <label>X（Twitter）{text('x_handle','https://x.com/yourid')}</label>
        <label>Instagram{ text('instagram','https://instagram.com/yourid') }</label>
        <label>Facebook{  text('facebook','https://facebook.com/yourid') }</label>
        <label>LinkedIn{  text('linkedin','https://linkedin.com/in/yourid') }</label>
        <label>YouTube{   text('youtube','https://youtube.com/@yourid') }</label>
        <label>Webサイト{ text('website_url','https://example.com') }</label>
      </div>
    </Wrapper>
  );
}
