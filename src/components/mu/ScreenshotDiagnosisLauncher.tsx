'use client';

import { useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { saveScreenshotImageLocal } from '@/lib/browser/screenshotImageStore';

type ScreenshotDiagnosisLauncherProps = {
  conversationId?: string | null;
  userType?: string | null;
};

type DiagnosisResponse = {
  ok?: boolean;
  diagnosis?: string;
  diagnosis_seed?: unknown;
  diagnosis_log_id?: string | null;
  error?: string;
  detail?: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

export default function ScreenshotDiagnosisLauncher({ conversationId = null, userType = null }: ScreenshotDiagnosisLauncherProps) {
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const normalizedUserType = String(userType || '').toLowerCase();
  const canUseScreenshotDiagnosis = ['premium', 'master', 'partner', 'admin'].includes(normalizedUserType);

  async function runDiagnosis(file: File) {
    setOpen(true);
    setBusy(true);
    setError('');
    setDiagnosis('');
    setFileName(file.name || '');
    setPendingFile(null);

    try {
      if (!user) throw new Error('ログインが必要です。');
      if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。');
      if (file.size > 8 * 1024 * 1024) throw new Error('画像サイズが大きすぎます。8MB以内にしてください。');

      const imageDataUrl = await fileToDataUrl(file);
      const idToken = await user.getIdToken(true);

      const res = await fetch('/api/mu/screenshot-diagnosis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          image_data_url: imageDataUrl,
          imageDataUrl,
          source: 'mu_chat',
          conversation_id: conversationId,
        }),
      });

      const json = (await res.json().catch(() => ({}))) as DiagnosisResponse;
      console.log('[screenshot-diagnosis] response', json);

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || json?.detail || 'スクショ診断に失敗しました。');
      }

            const diagnosisText = String(json.diagnosis || '').trim();
      const localImageId = String(json.diagnosis_log_id || '').trim();

      if (localImageId) {
        await saveScreenshotImageLocal(localImageId, imageDataUrl)
          .then(() => {
            console.log('[screenshot-image] saved to IndexedDB', { localImageId });
          })
          .catch((err) => {
            console.warn('[screenshot-image] save failed', { localImageId, err });
          });
      }

      setDiagnosis(diagnosisText);

      if (typeof window !== 'undefined' && diagnosisText) {
        window.dispatchEvent(
          new CustomEvent('iros:screenshot-diagnosis-complete', {
            detail: {
              diagnosis: diagnosisText,
              diagnosis_seed: json.diagnosis_seed ?? null,
              image_data_url: imageDataUrl,
              local_image_id: localImageId || null,
            },
          }),
        );
      }
    } catch (e: any) {
      setError(e?.message || 'スクショ診断に失敗しました。');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;

          setPendingFile(file);
          setFileName(file.name || '');
          setDiagnosis('');
          setError('');
          setBusy(false);
          setOpen(true);
        }}
      />

      <button
        type="button"
        disabled={!canUseScreenshotDiagnosis || busy}
        onClick={() => {
          if (!canUseScreenshotDiagnosis || busy) return;
          inputRef.current?.click();
        }}
        aria-label="スクショ診断"
        title={canUseScreenshotDiagnosis ? 'スクショ診断' : 'スクショ診断はプレミアム以上で利用できます'}
        style={{
          position: 'fixed',
          right: 34,
          bottom: 'calc(var(--footer-h, 60px) + 92px)',
          zIndex: 2147483000,
          width: 46,
          height: 46,
          borderRadius: 999,
          border: '1px solid rgba(150, 140, 255, 0.45)',
          background: canUseScreenshotDiagnosis ? 'rgba(255, 255, 255, 0.92)' : 'rgba(230, 230, 235, 0.75)',
          color: canUseScreenshotDiagnosis ? '#4b3fd8' : '#9ca3af',
          fontSize: 18,
          fontWeight: 800,
          boxShadow: canUseScreenshotDiagnosis ? '0 10px 26px rgba(80, 70, 180, 0.22)' : 'none',
          backdropFilter: 'blur(10px)',
          cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 0.8,
        }}
      >
        📎
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2147483001,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.42)',
            padding: 16,
          }}
          onClick={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div
            style={{
              width: 'min(420px, 100%)',
              maxHeight: '78dvh',
              overflow: 'auto',
              borderRadius: 20,
              background: 'rgba(255,255,255,0.98)',
              color: '#1f1630',
              padding: 18,
              boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>スクショ診断</div>
                {fileName ? (
                  <div style={{ marginTop: 4, fontSize: 12, color: '#6b6475' }}>
                    {fileName}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => { setPendingFile(null); setOpen(false); }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontSize: 20,
                  lineHeight: 1,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.4 : 0.8,
                }}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>

            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
              {pendingFile && !busy && !diagnosis && !error ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>
                    スクショ診断には5クレジット消費されます。
                  </div>
                  <div style={{ color: '#6b6475' }}>
                    よろしければOKを押してください。OK後に画像を読み込み、診断を開始します。
                  </div>
                </>
              ) : busy ? (
                '診断しています…'
              ) : error ? (
                error
              ) : (
                diagnosis
              )}
            </div>
            {pendingFile && !busy && !diagnosis && !error ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setPendingFile(null);
                    setOpen(false);
                    if (inputRef.current) inputRef.current.value = '';
                  }}
                  style={{
                    border: '1px solid rgba(148, 163, 184, 0.45)',
                    background: 'rgba(255,255,255,0.9)',
                    borderRadius: 999,
                    padding: '9px 14px',
                    fontSize: 13,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 0.8,
                  }}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (pendingFile) void runDiagnosis(pendingFile);
                  }}
                  style={{
                    border: 'none',
                    background: 'linear-gradient(135deg, #8b8cff, #7b61ff)',
                    color: '#fff',
                    borderRadius: 999,
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 0.8,
                    boxShadow: '0 8px 20px rgba(90, 80, 220, 0.25)',
                  }}
                >
                  OK
                </button>
              </div>
            ) : null}

            {!busy && diagnosis ? (
              <div style={{ marginTop: 14, fontSize: 12, color: '#6b6475', lineHeight: 1.6 }}>
                この診断は保存され、本線Muの会話から参照できるようになります。
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}















