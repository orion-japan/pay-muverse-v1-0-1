'use client';

import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import './MyInvitePanel.css';

type InviteInfo = {
  link: string;
  ref: string;
  rcode?: string | null;
  mcode?: string | null;
  group?: string | null;
};

export default function MyInvitePanel() {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [toEmail, setToEmail] = useState('');
  const [senderName, setSenderName] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/my/invite-info', { method: 'GET' });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || 'failed');
        setInfo(j);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        setMsg(`読み込みエラー: ${message}`);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, []);

  useEffect(() => {
    // リンクが取れたら QR を生成
    if (info?.link && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, info.link, { margin: 1, width: 240 }, (err) => {
        if (err) {
          const message = err instanceof Error ? err.message : String(err);
          setMsg(`QR生成エラー: ${message}`);
        }
      });
    }
  }, [info]);

  const copyLink = async () => {
    if (!info?.link) return;
    await navigator.clipboard.writeText(info.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const sendEmail = async () => {
    if (!info?.link) return;
    if (!toEmail) {
      setMsg('送信先メールを入力してください');
      return;
    }
    try {
      const r = await fetch('/api/my/send-invite-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: toEmail, link: info.link, senderName }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '送信に失敗しました');
      setMsg('メールを送信しました');
      setToEmail('');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setMsg(`メール送信エラー: ${message}`);
    }
  };

  return (
    <div className="inv-root">
      <h2 className="inv-h2">招待リンク・メール・QR</h2>

      {loading && <div className="inv-box">読み込み中...</div>}
      {!loading && !info && (
        <div className="inv-box inv-err">{msg || '情報が取得できませんでした'}</div>
      )}

      {info && (
        <div className="inv-grid">
          {/* 1) リンク */}
          <section className="inv-box">
            <h3 className="inv-title">招待リンク</h3>
            <p className="inv-link">{info.link}</p>
            <div className="inv-row">
              <button className="inv-btn" onClick={copyLink}>
                リンクをコピー
              </button>
              {copied && <span className="inv-ok">✓ コピーしました</span>}
            </div>
            <div className="inv-meta">
              <div>
                <label>ref</label>
                <span>{info.ref}</span>
              </div>
              {info.rcode && (
                <div>
                  <label>rcode</label>
                  <span>{info.rcode}</span>
                </div>
              )}
              {info.mcode && (
                <div>
                  <label>mcode</label>
                  <span>{info.mcode}</span>
                </div>
              )}
              {info.group && (
                <div>
                  <label>group</label>
                  <span>{info.group}</span>
                </div>
              )}
            </div>
            <p className="inv-note">※ パラメータ必須ポリシーに合わせ、必要なクエリを含んでいます。</p>
          </section>

          {/* 2) QRコード */}
          <section className="inv-box">
            <h3 className="inv-title">QRコード</h3>
            <canvas ref={canvasRef} className="inv-qr" />
            <p className="inv-note">イベント現場や対面案内でご利用ください。</p>
          </section>

          {/* 3) メール送信 */}
          <section className="inv-box">
            <h3 className="inv-title">メールで送る</h3>
            <div className="inv-field">
              <label>宛先メール</label>
              <input
                className="inv-input"
                type="email"
                placeholder="example@example.com"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
              />
            </div>
            <div className="inv-field">
              <label>あなたの表示名（任意）</label>
              <input
                className="inv-input"
                type="text"
                placeholder="あなたの名前（差出人名に入ります）"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
              />
            </div>
            <button className="inv-btn" onClick={sendEmail}>
              送信する
            </button>
            {msg && <p className="inv-msg">{msg}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
