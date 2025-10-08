'use client';

import React, { useCallback, useRef, useState } from 'react';
import MuiComposer from './MuiComposer';
import MuiMessageList from './MuiMessageList';
import type { Msg, MuiApiRes } from './types';
import { api } from '@/lib/net/api';
import { useMuiDrop } from './useMuiDrop';
import { runOcrPipeline } from '@/lib/ocr/ocrPipeline';

// ★（任意型）ステージで使う型を残しておく。未使用でも構造維持のため。
import type { StageId, Tone } from './types';

export default function MuiChat() {
  // 会話系
  const [conv, setConv] = useState<Msg[]>([]);
  const [convCode, setConvCode] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OCR
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrPreview, setOcrPreview] = useState<string | null>(null);

  // 入力欄（親制御）
  const [composerText, setComposerText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ★ 追加：OCR→本文に入れた直後だけ広げる
  const [composerExpanded, setComposerExpanded] = useState(false);

  // 画像D&D / 選択
  const {
    files, urls, dragScreen,
    fileRef, addFiles, onPick, onFileChange, setDragScreen,
  } = useMuiDrop();

  // （任意のユーザー識別）
  const userCode: string =
    (typeof window !== 'undefined' && (window as any).__USER_CODE__) || 'ANON';

  // ★ 追加：ケースID（seed_id）を内部で1つ持っておく（UI変更なし）
  const [seedId] = useState<string>(() => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `CASE-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
  });

  /** 下端スクロール（既存方式を維持） */
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  // ───────────────────────────────────────────────────────────────
  // 本体エージェント呼び出し（通常送信）
  type AgentResult = { reply: string; conversation_code: string | null; balance: number | null };

  const callAgent = useCallback(
    async (text: string): Promise<AgentResult> => {
      const url = `/api/agent/mui?user_code=${encodeURIComponent(userCode)}`;
      const json = await api<MuiApiRes>(url, {
        method: 'POST',
        body: JSON.stringify({
          text,
          conversation_code: convCode,
          user_code: userCode,
        }),
        headers: { 'x-user-code': userCode, 'Content-Type': 'application/json' },
      });

      const reply =
        (json as any).reply ??
        (json as any).message ??
        '…';

      const newCode =
        (json as any).conversation_code ??
        (json as any).conv_code ??
        convCode ??
        null;
      if (newCode) setConvCode(String(newCode));

      const newBal =
        typeof (json as any).balance === 'number'
          ? (json as any).balance
          : typeof (json as any).credit === 'number'
          ? (json as any).credit
          : null;
      if (typeof newBal === 'number') setBalance(newBal);

      return {
        reply: String(reply),
        conversation_code: newCode ? String(newCode) : null,
        balance: typeof newBal === 'number' ? newBal : null,
      };
    },
    [convCode, userCode]
  );

  // 返信っぽさの簡易検出（です/ます口調＋勧誘/質問など）
  function isLikelyReply(t: string): boolean {
    const s = String(t || '').replace(/\s+/g, '');
    const pats = [
      /ですね[。!?]*$/, /でしょうか[。!?]*$/, /くださいね[。!?]*$/,
      /と思います[。!?]*$/, /いかがですか[。!?]*$/, /お役に立て/g,
    ];
    if (pats.some((r) => r.test(s))) return true;
    // 「あなた/私/お話/教えて」多用 & A/Bラベルが無い → 会話文っぽい
    const polite = (s.match(/です|ます/g)?.length ?? 0) >= 5;
    if (polite && /あなた|私|お話|教えて/.test(s) && !/^A|^B/m.test(t)) return true;
    return false;
  }

  // 意味を変えないローカル簡易整形（最終フォールバック）
  function simpleFormat(raw: string): string {
    let s = String(raw || '');
    s = s.replace(/[ \t]+/g, ' ').replace(/\u3000/g, ' ');
    s = s
      .replace(/\s*([。！？…、，,.!?])/g, '$1')
      .replace(/([「『（(【])\s+/g, '$1')
      .replace(/\s+([」』）)】])/g, '$1');
    // 和文の字間スペース除去
    s = s.replace(/([ぁ-んァ-ヶ一-龥ー])\s+(?=[ぁ-んァ-ヶ一-龥ー])/g, '$1');
    // 軽微な誤認補正
    s = s.replace(/おはよ一/g, 'おはよー').replace(/言っる/g, '言ってる');
    s = s.replace(/(\n){3,}/g, '\n\n');
    return s.trim();
  }

  /** 整形専用呼び出し（format_only） */
  const callAgentFormatOnly = useCallback(
    async (raw: string) => {
      // ガード付きプロンプトで「整形のみ」を強制
      const guarded = [
        '<<FORMAT_ONLY>>',
        '【指示】以下の原文を、意味を変えずに句読点/改行/誤字のみ整える。',
        '・新しい助言/相槌/質問/要約/説明は一切追加しない',
        '・話者ラベル（A/B等）や文脈タグは保持',
        '・出力は整形後の本文のみ（前置き/後書き禁止）',
        '【原文】',
        raw,
        '<<END>>',
      ].join('\n');

      const url = `/api/agent/mui?user_code=${encodeURIComponent(userCode)}`;
      const json = await api<MuiApiRes>(url, {
        method: 'POST',
        body: JSON.stringify({
          text: guarded,
          mode: 'format_only',
          instruction:
            '整形のみ。誤字訂正・不要記号除去・句読点/改行の整理。意味や内容の追加/改変は禁止。話者A/Bやタグは保持。出力は本文のみ。',
          conversation_code: convCode,
          user_code: userCode,
        }),
        headers: { 'x-user-code': userCode, 'Content-Type': 'application/json' },
      });

      let reply =
        (json as any).formatted ??
        (json as any).reply ??
        (json as any).message ??
        '';

      const newCode =
        (json as any).conversation_code ??
        (json as any).conv_code ??
        convCode ??
        null;
      if (newCode) setConvCode(String(newCode));

      const newBal =
        typeof (json as any).balance === 'number'
          ? (json as any).balance
          : typeof (json as any).credit === 'number'
          ? (json as any).credit
          : null;
      if (typeof newBal === 'number') setBalance(newBal);

      // 返信っぽければローカル整形にフォールバック
      const out = String(reply || '').trim();
      if (!out || isLikelyReply(out)) {
        return simpleFormat(raw);
      }
      return out;
    },
    [convCode, userCode]
  );

  // ───────────────────────────────────────────────────────────────
  // OCR実行（従来：プレビュー）
  const runOCR = useCallback(async () => {
    if (!files.length) return;
    setError(null);
    setOcrRunning(true);
    try {
      const res = await runOcrPipeline(files, { lang: 'jpn+eng' });
      const text = (res?.rawText || '').trim();
      if (!text) {
        setError('文字が認識できませんでした。');
        setOcrPreview(null);
      } else {
        setOcrPreview(text); // 従来のプレビュー表示
      }
    } catch (e: any) {
      setError(e?.message || 'OCR処理に失敗しました');
    } finally {
      setOcrRunning(false);
    }
  }, [files]);

  // 新：OCR→AI整形→本文へ（プレビューを出さない）
  const runOcrAndFormatToComposer = useCallback(async () => {
    if (!files.length) return;
    setError(null);
    setOcrRunning(true);
    try {
      const res = await runOcrPipeline(files, { lang: 'jpn+eng' });
      const text = (res?.rawText || '').trim();
      if (!text) {
        setError('文字が認識できませんでした。');
        setOcrPreview(null);
        return;
      }

      let formatted = '';
      try {
        formatted = (await callAgentFormatOnly(text)).trim();
      } catch (e) {
        console.warn('[format_only] failed, fallback to preview', e);
        setOcrPreview(text);
        return;
      }

      if (!formatted) {
        setOcrPreview(text);
        return;
      }

      const next = composerText ? composerText + '\n' + formatted : formatted;
      setComposerText(next);
      setComposerExpanded(true);       // ★ ここで広げる
      setOcrPreview(null);
      scrollToBottom();
    } catch (e: any) {
      setError(e?.message || 'OCR処理に失敗しました');
    } finally {
      setOcrRunning(false);
    }
  }, [files, composerText, callAgentFormatOnly, scrollToBottom]);

  // プレビュー → 入力欄に反映（従来）
  const applyOcrToComposer = useCallback(() => {
    if (!ocrPreview) return;
    const next = composerText ? composerText + '\n' + ocrPreview : ocrPreview;
    setComposerText(next);
    setComposerExpanded(true);         // ★ ここでも広げる
    setOcrPreview(null);
    scrollToBottom();
  }, [ocrPreview, composerText, scrollToBottom]);

  const discardOcrPreview = useCallback(() => setOcrPreview(null), []);

  // 送信処理
  const handleComposerSend = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      setError(null);

      const userMsg: Msg = { role: 'user', content: trimmed };
      setConv((p) => [...p, userMsg]);
      setComposerText('');
      setComposerExpanded(false);      // ★ 送信後は閉じる
      scrollToBottom();

      try {
        const { reply, conversation_code: cc } = await callAgent(trimmed);

        const assistantMsg: Msg = { role: 'assistant', content: String(reply) };
        setConv((p) => [...p, assistantMsg]);
        scrollToBottom();

        // 会話ログ保存（失敗してもUIは進行）
        try {
          await api('/api/agent/mui/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversation_code: cc, // ★ そのターンで確定したIDで保存
              messages: [
                { role: 'user', content: userMsg.content },
                { role: 'assistant', content: assistantMsg.content },
              ],
            }),
          });
        } catch (e) {
          console.warn('[mui/log] save failed', e);
        }
      } catch (e: any) {
        setError(e?.message || '送信に失敗しました');
      }
    },
    [callAgent, scrollToBottom]
  );

  /** 追加：直前のアシスタント返答を整形→本文へ */
  const formatLastAssistantToComposer = useCallback(async () => {
    setError(null);
    const last = [...conv].reverse().find(m => m.role === 'assistant');
    if (!last || !last.content?.trim()) {
      setError('整形対象のアシスタント返答が見つかりません。');
      return;
    }
    try {
      const formatted = (await callAgentFormatOnly(last.content)).trim();
      if (!formatted) {
        setError('整形結果が空でした。');
        return;
      }
      const next = composerText ? composerText + '\n' + formatted : formatted;
      setComposerText(next);
      setComposerExpanded(true);       // 整形→本文でも広げる
      scrollToBottom();
    } catch (e: any) {
      setError(e?.message || '整形に失敗しました');
    }
  }, [conv, composerText, callAgentFormatOnly, scrollToBottom]);

  // ★ 任意：ステージ保存ヘルパー（UI変更なし）
  const saveStage = useCallback(async (params: {
    sub_id: StageId;
    partner_detail: string;
    tone: Tone;
    next_step: string;
    currentQ?: string; depthStage?: string; phase?: Tone['phase']; self_accept?: number;
  }) => {
    try {
      const res = await api<{ ok: boolean; quartet?: any; error?: string }>(
        '/api/agent/mui/stage/save',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
          body: JSON.stringify({
            user_code: userCode,
            seed_id: seedId,
            ...params,
          }),
        }
      );
      if (!(res as any).ok) throw new Error((res as any).error || 'save failed');
      return true;
    } catch (e) {
      console.warn('[stage/save] failed', e);
      return false;
    }
  }, [seedId, userCode]);

  const placeholder =
    files.length > 0
      ? '（Ctrl/Cmd+Enterで送信）'
      : 'メッセージを入れて送信';

  return (
    <>
      <header className="mui-header">
        <div className="left">
          <h1 className="mui-title">Mui — 恋愛相談</h1>
          <p className="sub">
            会話コード: {convCode ?? '—'} / 残高: {balance ?? '—'}
          </p>
        </div>

        <div className="right">
          <button className="ghost" onClick={onPick} disabled={ocrRunning}>
            画像を選ぶ
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          <button
            className="primary"
            onClick={runOcrAndFormatToComposer}
            disabled={!files.length || ocrRunning}
            style={{ marginRight: 8 }}
          >
            {ocrRunning ? '処理中…' : 'AIで整形して本文へ'}
          </button>
          <button
            className="ghost"
            onClick={runOCR}
            disabled={!files.length || ocrRunning}
          >
            {ocrRunning ? 'OCR中…' : 'OCRで読み取る'}
          </button>
        </div>
      </header>

      {/* 直前返答の整形ショートカット */}
      <div className="inline-actions" style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button className="ghost" onClick={formatLastAssistantToComposer}>
          直前の返答を整形→本文
        </button>
      </div>

      {/* プレビュー領域：サムネグリッド */}
      <section className="dropzone">
        {urls.length ? (
          <div className="preview-grid">
            {urls.map((u, i) => (
              <div key={i} className="preview-item">
                <img src={u} alt={`preview-${i}`} draggable={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className="drop-hint">
            <strong>ここにLINEスクショをドロップ</strong>
            <span>または右上の「画像を選ぶ」からアップロード</span>
          </div>
        )}
      </section>

      {/* OCR結果プレビュー（従来） */}
      {ocrPreview && (
        <section className="ocr-preview">
          <div className="ocr-title">OCR結果プレビュー</div>
          <pre className="ocr-snippet">
            {ocrPreview.length > 3000 ? ocrPreview.slice(0, 3000) + '…' : ocrPreview}
          </pre>
          <div className="ocr-actions">
            <button className="primary" onClick={applyOcrToComposer}>
              本文に反映
            </button>
            <button className="ghost" onClick={discardOcrPreview}>
              破棄
            </button>
          </div>
        </section>
      )}

      {/* 会話ログ */}
      <MuiMessageList items={conv} />

      {/* 入力欄（親制御） */}
      <div className="mui-composer">
        <MuiComposer
          placeholder={placeholder}
          value={composerText}
          onChange={(v) => {
            setComposerText(v);
            if (!v.trim()) setComposerExpanded(false); // 空に戻ったら閉じる
          }}
          onSend={() => handleComposerSend(composerText)}
          sending={ocrRunning}
          textareaRef={textareaRef}
          expanded={composerExpanded}       // ★ 追加
        />
      </div>

      {error && <div className="error">{error}</div>}

      {/* 全画面ドロップオーバーレイ */}
      {dragScreen && (
        <div
          className="drop-overlay"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setDragScreen(false);
            const dt = e.dataTransfer;
            if (dt?.files?.length) addFiles(dt.files);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragScreen(false);
          }}
        >
          <div className="overlay-inner">ここにドロップして追加</div>
        </div>
      )}
    </>
  );
}
