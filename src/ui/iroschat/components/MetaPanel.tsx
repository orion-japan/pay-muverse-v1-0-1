'use client';

import React from 'react';

export type MetaData = {
  title?: string;
  summary?: string;
  tags?: string[];
  // 何が来ても受けられるように
  [k: string]: any;
};

type Props = {
  meta?: MetaData | null;
  mirraHistory?: Array<{ id: string; title?: string | null; updated_at?: string | null }>;
  onClose?: () => void;
};

export function MetaPanel({ meta, mirraHistory, onClose }: Props) {
  if (!meta && !mirraHistory?.length) return null;

  return (
    <aside
      className="iros-meta-panel"
      style={{
        padding: 12,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: '#0e0f13',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13, opacity: 0.9 }}>Meta</strong>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              padding: '2px 6px',
              color: '#e8eaf1',
              cursor: 'pointer',
            }}
          >
            閉じる
          </button>
        )}
      </div>

      {meta && (
        <div style={{ marginBottom: 10 }}>
          {meta.title && (
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <span style={{ opacity: 0.6 }}>タイトル：</span>
              <span>{meta.title}</span>
            </div>
          )}
          {meta.summary && (
            <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.9, whiteSpace: 'pre-wrap' }}>
              {meta.summary}
            </div>
          )}
          {Array.isArray(meta.tags) && meta.tags.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {meta.tags.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.12)',
                    opacity: 0.85,
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {mirraHistory?.length ? (
        <div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>最近の履歴</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {mirraHistory.map((h) => (
              <li
                key={h.id}
                style={{
                  fontSize: 12,
                  padding: '6px 8px',
                  borderRadius: 8,
                  background: '#0f1115',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
                title={h.updated_at || ''}
              >
                {h.title || h.id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

export default MetaPanel;
