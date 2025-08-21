// src/lib/pushClient.ts
let toastInstalled = false;

export async function ensurePushReady() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  // SW 登録（既に登録済みならそのまま）
  const reg = await navigator.serviceWorker.register('/sw.js');

  // 通知権限が未決なら1回だけ要求
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }

  // フォールバック用トーストの受信をセット
  if (!toastInstalled) {
    toastInstalled = true;
    navigator.serviceWorker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg?.type === 'PUSH_FALLBACK') {
        showToast(msg.title ?? 'お知らせ', msg.body ?? '', msg.url ?? '/');
      }
    });
  }

  return reg;
}

// 超シンプルなページ内トースト
function showToast(title: string, body: string, url: string) {
  // 既存があれば消す
  const old = document.querySelector('#mu-push-toast');
  if (old) old.remove();

  const wrap = document.createElement('div');
  wrap.id = 'mu-push-toast';
  wrap.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    max-width: 320px; padding: 12px 14px; border-radius: 12px;
    background: rgba(30,30,30,0.95); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.25);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
    cursor: pointer;`;
  wrap.innerHTML = `
    <div style="font-weight:600; margin-bottom:6px; font-size:14px;">${escapeHtml(title)}</div>
    <div style="opacity:.9; font-size:13px; line-height:1.4;">${escapeHtml(body)}</div>
  `;
  wrap.onclick = () => { window.location.href = url; wrap.remove(); };
  document.body.appendChild(wrap);

  // 8秒で自動消去
  setTimeout(() => wrap.remove(), 8000);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
