'use client';

import React, { useMemo, useEffect, useRef } from 'react';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
};

type Props = {
  items: Msg[];
};

const READ_RE = /^(既読(?:\s*\d+)?|既読済み)\s*$/;

/** 既読と本文を分離 */
function splitRead(content: string) {
  const lines = content.split(/\r?\n/);
  const nonRead: string[] = [];
  let hasRead = false;

  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    if (READ_RE.test(s)) {
      hasRead = true;
    } else {
      nonRead.push(s);
    }
  }
  return { text: nonRead.join('\n'), read: hasRead };
}

/** 同一roleの連投を塊化（＝“無言”区間の可視化に使う） */
function groupRuns(items: Msg[]) {
  const runs: { role: Msg['role']; msgs: (Msg & { read?: boolean; text?: string })[] }[] = [];
  let cur: { role: Msg['role']; msgs: (Msg & { read?: boolean; text?: string })[] } | null = null;

  for (const m of items) {
    const { text, read } = splitRead(m.content);
    const msg = { ...m, text, read };
    if (!cur || cur.role !== m.role) {
      cur = { role: m.role, msgs: [msg] };
      runs.push(cur);
    } else {
      cur.msgs.push(msg);
    }
  }
  return runs;
}

export default function MuiMessageList({ items }: Props) {
  const runs = useMemo(() => groupRuns(items), [items]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 🔽 メッセージが更新されたら常に最下部まで自動スクロール
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [items]);

  if (!items?.length) {
    return <div className="empty">まだメッセージがありません</div>;
  }

  return (
    <section className="chat">
      {runs.map((run, i) => {
        const isSelf = run.role === 'user'; // 右寄せ＝自分
        const noReply = run.msgs.length >= 2; // “無言”＝相手からの返信なし

        return (
          <div key={i} className={`run ${isSelf ? 'self' : 'partner'}`}>
            {/* 連投の先頭に軽いヘッダ（任意） */}
            {noReply && (
              <div className="run-sep">
                {isSelf ? '相手からの返信なし' : 'あなたからの返信なし'}
              </div>
            )}

            {run.msgs.map((m, j) => {
              const showRead = !!m.read && isSelf; // 既読は通常“自分の吹き出し側”に出す
              const text = (m as any).text ?? m.content;

              return (
                <div key={j} className={`bubble ${isSelf ? 'self' : 'partner'}`}>
                  <div className="content">
                    {text.split('\n').map((line, k) => (
                      <p key={k} className="line">
                        {line}
                      </p>
                    ))}
                  </div>

                  {/* 右下に既読バッジ */}
                  {showRead && <span className="read-chip">既読</span>}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 👇 ここが自動スクロールのアンカー */}
      <div ref={bottomRef} style={{ height: '1px' }} />
    </section>
  );
}
