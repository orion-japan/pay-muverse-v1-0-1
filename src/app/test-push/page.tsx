'use client';

import { useState } from 'react';

export default function TestPushPage() {
  const [userCode, setUserCode] = useState('U-CKxc5NQQ');
  const [title, setTitle] = useState('Muverse 通知テスト');
  const [body, setBody] = useState('これは Android Chrome のテスト通知です');
  const [url, setUrl] = useState('https://muverse.jp/');
  const [result, setResult] = useState<string>('');

  const send = async () => {
    setResult('送信中...');
    try {
      const res = await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          title,
          body,
          url,
          kind: 'generic', // consents 無視して送れるように
        }),
      });
      const text = await res.text();
      setResult(`status: ${res.status}\n${text}`);
    } catch (e: any) {
      setResult(`error: ${String(e?.message ?? e)}`);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 560, margin: '0 auto' }}>
      <h1>Push テスト</h1>
      <label>user_code</label>
      <input
        value={userCode}
        onChange={(e) => setUserCode(e.target.value)}
        style={{ width: '100%', margin: '6px 0' }}
      />
      <label>title</label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ width: '100%', margin: '6px 0' }}
      />
      <label>body</label>
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        style={{ width: '100%', margin: '6px 0' }}
      />
      <label>url</label>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{ width: '100%', margin: '6px 0' }}
      />
      <button onClick={send} style={{ marginTop: 12, padding: '10px 16px' }}>
        通知を送る
      </button>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: '#111',
          color: '#0f0',
          padding: 12,
          marginTop: 16,
        }}
      >
        {result}
      </pre>
    </div>
  );
}
