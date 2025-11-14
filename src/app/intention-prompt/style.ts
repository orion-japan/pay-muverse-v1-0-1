// src/app/intention-prompt/style.ts
// Intention Prompt Generator 共通スタイル定義
// Tailwind非使用・純CSSオブジェクト設計

export const wrap: React.CSSProperties = {
  padding: '24px',
  maxWidth: 960,
  margin: '0 auto',
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  lineHeight: 1.6,
  color: '#222',
  background: '#fafbfc',
};

export const h1: React.CSSProperties = {
  fontSize: 22,
  margin: '0 0 16px',
  fontWeight: 700,
  textAlign: 'center',
  color: '#222',
};

export const h2: React.CSSProperties = {
  fontSize: 18,
  margin: '0 0 12px',
  fontWeight: 700,
  color: '#333',
};

export const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr', // ← 上下構成に変更（左右ではなく縦並び）
  gap: 20,
  alignItems: 'start',
};

export const panelWide: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 10,
  padding: 20,
  background: '#fff',
  marginTop: 20,
  boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
};

export const panelWarn: React.CSSProperties = {
  border: '1px solid #f3c2c2',
  borderRadius: 10,
  padding: 20,
  background: '#fff6f6',
  marginTop: 20,
  boxShadow: '0 2px 6px rgba(0,0,0,0.03)',
};

export const row: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  flexWrap: 'wrap',
  marginTop: 12,
};

export const output: React.CSSProperties = {
  width: '100%',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  padding: 14,
  border: '1px solid #ccc',
  borderRadius: 8,
  background: '#f9fafb',
  fontSize: 13.5,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  minHeight: 260,
};

export const button: React.CSSProperties = {
  padding: '8px 16px',
  border: '1px solid #222',
  background: '#111',
  color: '#fff',
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'background 0.2s ease',
};

export const buttonGhost: React.CSSProperties = {
  padding: '8px 16px',
  border: '1px solid #bbb',
  background: '#fff',
  color: '#222',
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'background 0.2s ease, color 0.2s ease',
};

export const note: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  marginTop: 6,
};

export const ul: React.CSSProperties = {
  margin: '8px 0',
  paddingLeft: 18,
};

export const li: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
};

export const errorBox: React.CSSProperties = {
  padding: 8,
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  color: '#b00020',
  marginTop: 10,
};


/* === 追加: Mini パネル（解析結果表示用） === */
export const panelMini: React.CSSProperties = {
  padding: 16,
  background: '#fafafa',
  borderRadius: 8,
  border: '1px solid #ddd',
  fontSize: 13,
  display: 'grid',
  gap: 8,
};

/* === 追加: 小見出し === */
export const h3: React.CSSProperties = {
  margin: '4px 0',
  fontSize: 14,
  fontWeight: 600,
  color: '#333',
};

/* === 追加: 小さめコード表示 === */
export const codeMini: React.CSSProperties = {
  background: '#f4f4f4',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #ddd',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  lineHeight: 1.4,
};

/* === 追加: 画像プレビュー === */
export const preview: React.CSSProperties = {
  width: '100%',
  maxWidth: 900,
  borderRadius: 12,
  border: '1px solid #ccc',
  display: 'block',
  marginTop: 12,
};


/* === 追加: ギャラリーへ（サードボタン／ライトカラー） === */
export const buttonTertiary: React.CSSProperties = {
  padding: '8px 16px',
  border: '1px solid #ccc',
  background: '#fff',
  color: '#0b57d0',
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'all 0.2s ease',
};

buttonTertiary[':hover'] = {
  background: '#f0f6ff',
};

/* === 祈りフォーム：外枠カード === */
export const formCard: React.CSSProperties = {
  padding: 20,
  background: '#ffffff',
  borderRadius: 12,
  border: '1px solid #e5e7eb',
  boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
  display: 'grid',
  gap: 16,
};

/* === ラベル === */
export const formLabel: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  color: '#333',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

/* === 入力欄（input / textarea / select 共通） === */
export const formInput: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #ccc',
  borderRadius: 8,
  fontSize: 14,
  width: '100%',
  background: '#fafafa',
  transition: 'border 0.2s ease, background 0.2s ease',
};

export const formTextarea: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #ccc',
  borderRadius: 8,
  fontSize: 14,
  width: '100%',
  minHeight: 80,
  background: '#fafafa',
  transition: 'border 0.2s ease, background 0.2s ease',
};

export const formSelect: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #ccc',
  borderRadius: 8,
  fontSize: 14,
  background: '#fafafa',
  width: '100%',
};

/* ==== ボタン：Primary（黒） ==== */
export const buttonPrimary: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: 'none',
  background: '#111',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.2s ease',
};
buttonPrimary[':hover'] = { opacity: 0.85 };

/* ==== ボタン：Accent（紫） ==== */
export const buttonAccent: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: 'none',
  background: '#6b4ce6',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.2s ease',
};
buttonAccent[':hover'] = { opacity: 0.85 };

/* ==== ボタン：Success（青） ==== */
export const buttonSuccess: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: 'none',
  background: '#0b57d0',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.2s ease',
};
buttonSuccess[':hover'] = { opacity: 0.85 };

// ==== ボタン：Secondary（灰） ====
export const buttonSecondary: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: '1px solid #ccc',
  background: '#f5f5f5',
  color: '#444',
  fontSize: 15,
  cursor: 'pointer',
  transition: 'background 0.2s ease',
};

buttonSecondary[':hover'] = { background: '#e9e9e9' };
