'use client';

type Props = {
  summary: string;
  onConfirm: () => void;
  onEdit: () => void;
  onDiscard: () => void;
};

export default function MuiOcrConfirm({ summary, onConfirm, onEdit, onDiscard }: Props) {
  return (
    <div className="mui-ocr-confirm" role="region" aria-label="OCR要約の確認">
      <div className="text">
        <div className="title">OCRの要約</div>
        <div className="body" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{summary}</div>
      </div>
      <div className="btns">
        <button className="tiny ghost" onClick={onDiscard}>破棄</button>
        <button className="tiny" onClick={onEdit}>修正して送る</button>
        <button className="tiny primary" onClick={onConfirm}>この内容で送信</button>
      </div>
      <style jsx>{`
        .mui-ocr-confirm {
          display: grid; gap: 8px;
          background: rgba(124,140,255,.08);
          border: 1px solid rgba(124,140,255,.25);
          border-radius: 12px; padding: 12px;
          margin: 10px 0;
        }
        .title { font-weight: 600; margin-bottom: 4px; }
        .btns { display: flex; gap: 8px; justify-content: flex-end; }
        .tiny { padding: 4px 8px; border-radius: 8px; }
        .primary { border: 1px solid var(--accent); }
        .ghost { background: transparent; }
      `}</style>
    </div>
  );
}
