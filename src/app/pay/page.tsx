'use client';
export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import PlanSelectPanel from '@/components/PlanSelectPanel';
import CardStyle from '@/components/CardStyle';
import { getAuth } from 'firebase/auth';
import dayjs from 'dayjs';

/* ============ ログ ============ */
const TAG = '[PAY]';
let RUN = 0;
const t = () => `${(performance.now() / 1000).toFixed(3)}s`;
const log   = (...a: any[]) => console.log(TAG, ...a);
const warn  = (...a: any[]) => console.warn(TAG, ...a);
const error = (...a: any[]) => console.error(TAG, ...a);

/* ============ 型拡張 ============ */
declare global {
  interface Window {
    Payjp?: any;
    __payjpInstance?: any;
    __payjpElements?: {
      cardNumber?: any;
      cardExpiry?: any;
      cardCvc?: any;
    };
  }
}

/* ============ 軽量モーダル ============ */
function PayResultModal({
  open, title, message, onClose,
}: { open: boolean; title: string; message: string; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className="relative w-[92%] max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <p className="mt-2 text-sm text-gray-700 whitespace-pre-line">{message}</p>
        <div className="mt-4 flex justify-end">
          <button className="rounded-xl bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700" onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 小ユーティリティ ============ */
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, ms = 15000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  const merged: RequestInit = { ...init, signal: ac.signal };
  return fetch(input, merged).finally(() => clearTimeout(id));
}
async function getIdTokenWithTimeout(ms = 15000) {
  const u = getAuth().currentUser;
  if (!u) throw new Error('ログインしてください');
  return Promise.race<string>([
    u.getIdToken(true),
    new Promise((_, rej) => setTimeout(() => rej(new Error('IDトークンの取得がタイムアウトしました')), ms)),
  ]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closeThreeDSModal = () => {
  const host = document.querySelector('.payjp-3ds-modal') as HTMLElement | null;
  if (host) host.remove();
  document.body.classList.remove('payjp-3ds-open');
  document.getElementById('payjp-3ds-guard')?.remove();
};

/** PAY.JP の「既に同一プランに加入済み」などを成功扱いに倒す */
const isAlreadySubscribed = (payload: any): boolean => {
  try {
    const c1 = payload?.error?.code;
    const c2 = payload?.body?.error?.code;
    const msg = (payload?.error?.message || payload?.detail || '').toString().toLowerCase();
    return c1 === 'already_subscribed' || c2 === 'already_subscribed' || msg.includes('already_subscribed');
  } catch { return false; }
};

/** URL方式3DSの完了確認をポーリング（サーバ側で tds_finish → 購読作成を行う想定） */
const pollFinalizeSubscribe = async (
  finalizePayload: any,
  idToken: string,
  { timeoutMs = 120_000, intervalMs = 2_000 } = {}
) => {
  const started = Date.now();
  let lastDetail: any = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('/api/pay/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(finalizePayload),
      });
      const j = await res.json().catch(() => ({} as any));
      log('finalize poll tick', { ok: res.ok, payload: j });

      // 成功（サーバ側で tds_finish → 購読作成まで終わっている）
      if (res.ok && j?.success) return { ok: true, data: j };

      // 既に加入済みは成功相当として扱う
      if (isAlreadySubscribed(j)) {
        log('treat already_subscribed as success');
        return { ok: true, data: j, already: true };
      }

      // 明確に未完了っぽい文言は待機継続
      const d = String(j?.detail || '').toLowerCase();
      const looksPending =
        d.includes('pending') || d.includes('unverified') ||
        d.includes('require') || d.includes('confirm') ||
        d.includes('3ds') || d.includes('authenticate');

      if (looksPending || (!res.ok && res.status >= 500)) {
        await sleep(intervalMs);
        continue;
      }

      lastDetail = j?.detail || j?.error || `status ${res.status}`;
    } catch (e: any) {
      lastDetail = e?.message || e;
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: lastDetail || 'timeout' };
};

function PageInner() {
  const runId = useRef(++RUN).current;
  const searchParams = useSearchParams();
  const user_code = searchParams.get('user') || '';

  /* ---- 状態 ---- */
  const [userData, setUserData] = useState<any>(null);
  const [payjp, setPayjp] = useState<any>(null);
  const [cardNumber, setCardNumber] = useState<any>(null);
  const [cardExpiry, setCardExpiry] = useState<any>(null);
  const [cardCvc, setCardCvc] = useState<any>(null);
  const [cardReady, setCardReady] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [cardRegistered, setCardRegistered] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [userCredit, setUserCredit] = useState<number>(0);
  const [expired, setExpired] = useState(false);
  const [history, setHistory] = useState<any[]>([]);

  /* ---- モーダル ---- */
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');

  /* ---- ガード ---- */
  const initCalled = useRef(false);
  const registerCalled = useRef(false);

  /* ---------- ステータス取得 ---------- */
  const fetchStatus = async (forceAuth = false) => {
    const t0 = performance.now();
    try {
      let res: Response;

      if (forceAuth) {
        const idToken = await getIdTokenWithTimeout();
        log(`#${runId}`, 'fetchStatus(forceAuth) → POST /api/account-status', t());
        res = await fetchWithTimeout('/api/account-status', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store',
        });
      } else {
        if (!user_code) { warn(`#${runId}`, 'fetchStatus: user_code missing'); return; }
        const url = `/api/account-status?user=${user_code}`;
        log(`#${runId}`, 'fetchStatus(by code) → GET', url, t());
        res = await fetchWithTimeout(url, { cache: 'no-store' });
      }

      if (!res.ok) { warn(`#${runId}`, 'fetchStatus not ok:', res.status); return; }
      const json = await res.json();
      log(`#${runId}`, 'fetchStatus OK payload:', {
        plan_status: json?.plan_status,
        click_type: json?.click_type,
        valid_until: json?.plan_valid_until,
        card_registered: json?.card_registered,
      });

      setUserData(json);
      setCardRegistered(!!json.card_registered);
      setUserCredit(
        (typeof json.sofia_credit === 'number' ? json.sofia_credit : undefined) ??
        (typeof json.credit_remain === 'number' ? json.credit_remain : 0)
      );
      setHistory(Array.isArray(json.history) ? json.history : []);

      const until = json?.plan_valid_until || json?.sub_next_payment || null;
      const isExpired = !!until && dayjs(until).isBefore(dayjs(), 'minute');
      setExpired(!!isExpired);
      log(`#${runId}`, `fetchStatus done in ${(performance.now() - t0).toFixed(1)}ms, expired=${!!isExpired}`);
    } catch (err) {
      error(`#${runId}`, 'fetchStatus error:', err);
    }
  };

  useEffect(() => {
    log(`#${runId}`, 'mount', { user_code });
    if (user_code) fetchStatus(false);
    const unsub = getAuth().onAuthStateChanged((u) => {
      log(`#${runId}`, 'onAuthStateChanged', { signedIn: !!u });
      if (u) fetchStatus(true);
    });
    return () => {
      log(`#${runId}`, 'unmount');
      unsub();
      removeThreeDSGuards();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user_code]);

  /* ---------- PAY.JP ロード（iframe 3DS） ---------- */
  const ensurePayjpLoaded = () =>
    new Promise<void>((resolve, reject) => {
      const pubKey = process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY;
      if (!pubKey) warn('NEXT_PUBLIC_PAYJP_PUBLIC_KEY is missing');

      const boot = () => {
        try {
          if (!window.Payjp) { warn('Payjp global not ready'); return; }
          if (!window.__payjpInstance) {
            log('create Payjp instance (iframe workflow)');
            window.__payjpInstance = window.Payjp(pubKey!, { threeDSecureWorkflow: 'iframe' });
          }
          setPayjp(window.__payjpInstance);
          log('Payjp ready');
          resolve();
        } catch (e) { error('ensurePayjpLoaded boot error:', e); reject(e); }
      };

      if (window.__payjpInstance) { setPayjp(window.__payjpInstance); resolve(); return; }
      if (window.Payjp) { boot(); return; }

      log('inject pay.js');
      const id = 'payjp-v2-sdk';
      if (!document.getElementById(id)) {
        const s = document.createElement('script');
        s.id = id;
        s.src = 'https://js.pay.jp/v2/pay.js';
        s.async = true;
        s.onload = boot;
        s.onerror = (e) => { error('pay.js load error', e); reject(new Error('PAY.JP SDK の読み込みに失敗')); };
        document.body.appendChild(s);
      } else {
        const i = setInterval(() => { if (window.Payjp) { clearInterval(i); boot(); } }, 100);
        setTimeout(() => { clearInterval(i); if (!window.Payjp) reject(new Error('PAY.JP SDK が利用不可')); }, 8000);
      }
    });

  /* ---------- カード要素 初期化 ---------- */
  const initPayjpCard = async () => {
    if (initCalled.current) { log('initPayjpCard skipped'); return; }
    initCalled.current = true;
    log('initPayjpCard start');

    await ensurePayjpLoaded().catch((e) => error('ensurePayjpLoaded failed:', e));
    if (!window.__payjpInstance) { error('PAY.JP 初期化に失敗: window.Payjp 不在'); return; }

    if (window.__payjpElements?.cardNumber) {
      log('reuse shared elements');
      setCardNumber(window.__payjpElements.cardNumber!);
      setCardExpiry(window.__payjpElements.cardExpiry || null);
      setCardCvc(window.__payjpElements.cardCvc || null);
      setCardReady(true);
      return;
    }

    const numberHost = document.getElementById('card-number');
    const expiryHost = document.getElementById('card-expiry');
    const cvcHost = document.getElementById('card-cvc');
    const alreadyMounted = !!numberHost?.querySelector('iframe') || !!expiryHost?.querySelector('iframe') || !!cvcHost?.querySelector('iframe');

    if (alreadyMounted) {
      log('hosts already have iframes → wait and attach refs');
      setTimeout(() => {
        if (window.__payjpElements?.cardNumber) {
          setCardNumber(window.__payjpElements.cardNumber!);
          setCardExpiry(window.__payjpElements.cardExpiry || null);
          setCardCvc(window.__payjpElements.cardCvc || null);
          setCardReady(true);
          log('attached shared refs');
        } else {
          warn('iframes exist but __payjpElements missing');
        }
      }, 300);
      return;
    }

    try {
      const pj = window.__payjpInstance;
      const elements = pj.elements();
      const cn = elements.create('cardNumber');  cn.mount('#card-number');
      const ce = elements.create('cardExpiry');  ce.mount('#card-expiry');
      const cc = elements.create('cardCvc');     cc.mount('#card-cvc');

      window.__payjpElements = { ...(window.__payjpElements || {}), cardNumber: cn, cardExpiry: ce, cardCvc: cc };
      setCardNumber(cn); setCardExpiry(ce); setCardCvc(cc); setCardReady(true);
      log('mounted new elements');
    } catch (e) { error('initPayjpCard mount error:', e); }
  };

  /* ---------- 3DS ガード ---------- */
  const addThreeDSGuards = () => {
    if (document.getElementById('payjp-3ds-guard')) return;
    const style = document.createElement('style');
    style.id = 'payjp-3ds-guard';
    style.textContent = `
      body.payjp-3ds-open .pay-main, 
      body.payjp-3ds-open .pay-main * {
        pointer-events: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
      }
      body.payjp-3ds-open { overflow: hidden !important; touch-action: none !important; }
      .payjp-3ds-modal, .payjp-3ds-modal * { z-index: 9998 !important; }
    `;
    document.head.appendChild(style);
    document.body.classList.add('payjp-3ds-open');
  };
  const removeThreeDSGuards = () => {
    document.getElementById('payjp-3ds-guard')?.remove();
    document.body.classList.remove('payjp-3ds-open');
  };

  // SDK: iframeワークフロー（charge_id or tdsr_id どちらでも受け付け）
  const runThreeDSIframe = async (objectId: string) => {
    log('runThreeDSIframe', { objectId });
    await ensurePayjpLoaded();
    if (!window.__payjpInstance) throw new Error('PAY.JP が初期化されていません');
    addThreeDSGuards();
    try {
      // payjp.js v1/v2: openThreeDSecureIframe はオブジェクトID（ch_xxx or tdsr_xxx）を受け付ける
      await window.__payjpInstance.openThreeDSecureIframe(objectId);
    } catch (e) {
      error('3DS iframe error:', e);
    } finally {
      removeThreeDSGuards();
    }
  };

  // URLフォールバック：モーダルを「開くだけ」。完了はサーバをポーリング
  const runThreeDSViaUrl = (url: string) => {
    addThreeDSGuards();
    return new Promise<void>((resolve) => {
      const host = document.createElement('div');
      host.className = 'payjp-3ds-modal fixed inset-0 flex items-center justify-center';
      host.innerHTML = `
        <div class="absolute inset-0 bg-black/40"></div>
        <div class="relative w-[92%] max-w-sm h-[560px] bg-white rounded-2xl shadow-xl overflow-hidden">
          <div class="absolute left-3 top-2 text-xs text-gray-600">本人認証を実行中… 開かない場合は「別タブで開く」を押してください</div>
          <iframe id="payjp-3ds-fb-iframe" src="${url}" style="width:100%;height:100%;border:0;" allow="payment *"></iframe>
          <div class="absolute right-2 top-2 flex gap-2">
            <button id="payjp-3ds-fb-open" class="bg-indigo-600 text-white text-xs px-2 py-1 rounded">別タブで開く</button>
            <button id="payjp-3ds-fb-close" class="bg-black/60 text-white text-xs px-2 py-1 rounded">閉じる</button>
          </div>
        </div>
      `;
      document.body.appendChild(host);

      const close = () => { host.remove(); removeThreeDSGuards(); resolve(); };
      host.querySelector<HTMLButtonElement>('#payjp-3ds-fb-close')?.addEventListener('click', close);
      host.querySelector<HTMLButtonElement>('#payjp-3ds-fb-open')?.addEventListener('click', () => {
        window.open(url, '_blank', 'noopener,noreferrer');
      });

      // セーフティ（5分）
      setTimeout(close, 300000);
    });
  };

  /* ---------- カード登録 ---------- */
  const createTokenWithTimeout = async (el: any, ms = 15000) =>
    Promise.race([
      payjp?.createToken(el, { three_d_secure: true }), // 3DS付トークン作成（サーバ側で /tokens/:id/tds_finish を呼ぶ想定）:contentReference[oaicite:4]{index=4}
      new Promise((_, reject) => setTimeout(() => reject(new Error('タイムアウトしました')), ms)),
    ]);

  const handleCardRegistration = async () => {
    log('handleCardRegistration clicked', { loading: loading, guard: registerCalled.current });
    if (registerCalled.current || loading) return;

    registerCalled.current = true;
    setLoading(true);
    try {
      await ensurePayjpLoaded();
      const idToken = await getIdTokenWithTimeout();

      const res = await fetchWithTimeout('/api/account-status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
      });
      const j = await res.json();
      const resolvedCode = j?.user_code;
      if (!resolvedCode) throw new Error('ユーザーコードが取得できません');

      const el = window.__payjpElements?.cardNumber || cardNumber;
      if (!payjp || !el) throw new Error('PAY.JP が初期化されていません');

      let tokenRes: any;
      try {
        tokenRes = await payjp.createToken(el, { three_d_secure: true });
      } catch {
        tokenRes = await createTokenWithTimeout(el);
      }
      if (!tokenRes?.id) throw new Error(tokenRes?.error?.message || 'カードトークンの取得に失敗しました');
      const token = tokenRes.id;
      log('card token created (3DS pending)', { token });

      const cardRes = await fetchWithTimeout('/api/pay/account/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          user_code: resolvedCode,
          token,
          ...(j?.payjp_customer_id ? { customer_id: j.payjp_customer_id } : {}),
        }),
      });
      const cardJson = await cardRes.json().catch(() => ({}));
      if (!cardRes.ok || !cardJson?.success) throw new Error(cardJson?.error || `カード登録失敗: ${cardRes.status}`);

      setCardRegistered(true);
      setModalTitle('カード登録（本人認証）が完了しました');
      setModalMessage('次にプランを選んで購入できます。');
      setModalOpen(true);
      await fetchStatus(true);
    } catch (err: any) {
      error('Card registration error:', err);
      setModalTitle('カード登録に失敗しました');
      setModalMessage(String(err?.message || err));
      setModalOpen(true);
    } finally {
      setLoading(false);
      registerCalled.current = false;
    }
  };

  /* ---------- サブスク登録（1回目→3DS→確定 or 既存扱い） ---------- */
  const handleSubscribe = async () => {
    log('subscribe button clicked', { loading, selectedPlan });
    if (loading) return;

    if (!selectedPlan?.plan_type) {
      setModalTitle('エラー');
      setModalMessage('プランを選択してください');
      setModalOpen(true);
      return;
    }

    // 既に同一プランが有効なら成功扱いで早期リターン
    if (userData?.plan_status === selectedPlan.plan_type && !expired) {
      log('already on this plan → short-circuit success');
      setModalTitle('すでにこのプランに加入済みです');
      setModalMessage('そのままご利用いただけます。');
      setModalOpen(true);
      return;
    }

    setLoading(true);
    try {
      const idToken = await getIdTokenWithTimeout();

      const accRes = await fetchWithTimeout('/api/account-status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
      });
      if (!accRes.ok) {
        const t = await accRes.text().catch(() => '');
        throw new Error(`アカウント情報の取得に失敗しました: ${t || accRes.status}`);
      }
      const acc = await accRes.json();

      const resolvedCode: string | undefined = acc?.user_code;
      const customerId: string | undefined = acc?.payjp_customer_id;
      const userEmail: string | undefined = acc?.click_email;

      if (!resolvedCode) throw new Error('user_code を解決できませんでした');
      if (!customerId) throw new Error('PAY.JP の顧客IDがありません（カード登録が必要です）');

      const basePayload = {
        user_code: resolvedCode,
        user_email: userEmail || '',
        plan_type: selectedPlan.plan_type,
        customer_id: customerId,
        charge_amount: selectedPlan.price || 0,
        sofia_credit: selectedPlan.credit || 0,
        force_cancel_existing: true,
      };

      // 1回目：与信＋3DS要否
      log('subscribe first → /api/pay/subscribe', basePayload);
      const firstRes = await fetchWithTimeout('/api/pay/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(basePayload),
      });
      const first = await firstRes.json().catch(() => ({} as any));
      log('subscribe first response', { ok: firstRes.ok, first });

      // 3DS不要 → 完了
      if (firstRes.ok && first?.success) {
        setModalTitle('サブスク登録が完了しました');
        setModalMessage('ご利用ありがとうございます。');
        setModalOpen(true);
        await fetchStatus(true);
        return;
      }

      // 既に加入済みエラーを成功扱い
      if (isAlreadySubscribed(first)) {
        log('first → already_subscribed (treat as success)');
        setModalTitle('すでにこのプランに加入済みです');
        setModalMessage('そのままご利用いただけます。');
        setModalOpen(true);
        await fetchStatus(true);
        return;
      }

      // 3DS 必須
      if (!first?.confirmation_required) {
        const detail =
          first?.detail ||
          (Array.isArray(first?.missing) && first.missing.length ? `欠落フィールド: ${first.missing.join(', ')}` : '原因不明');
        throw new Error(detail || '初回リクエストに失敗しました');
      }

      const tdsrId = first?.tdsr_id as string | undefined;
      const chargeId = first?.charge_id as string | undefined;
      const confirmUrl = first?.confirmation_url as string | undefined;

      const finalizePayload = { ...basePayload, tdsr_id: tdsrId, charge_id: chargeId };

      if (chargeId) {
        // SDKのiframeで開く（Chargeの3DSは ch_... を渡すのが公式）:contentReference[oaicite:5]{index=5}
        await runThreeDSIframe(chargeId);
        // 2回目：確定
        const finalizeRes = await fetchWithTimeout('/api/pay/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify(finalizePayload),
        });
        const finalize = await finalizeRes.json().catch(() => ({} as any));
        log('subscribe finalize response (SDK)', { ok: finalizeRes.ok, finalize });

        if (!(finalizeRes.ok && finalize?.success) && !isAlreadySubscribed(finalize)) {
          const detail =
            finalize?.detail ||
            (Array.isArray(finalize?.missing) && finalize.missing.length ? `欠落フィールド: ${finalize.missing.join(', ')}` : '原因不明');
          throw new Error(detail || 'サブスク登録に失敗しました');
        }
      } else if (confirmUrl) {
        // URLフォールバック：モーダルを開く（待たない）＋ポーリング
        const overlayPromise = runThreeDSViaUrl(confirmUrl);
        const poll = await pollFinalizeSubscribe(finalizePayload, idToken);
        if (poll.ok) {
          document.getElementById('payjp-3ds-fb-close')?.dispatchEvent(new Event('click'));
          closeThreeDSModal();
          await overlayPromise.catch(() => {});
        } else {
          throw new Error(
            typeof poll.error === 'string'
              ? `3Dセキュアの完了を確認できませんでした: ${poll.error}`
              : '3Dセキュアの完了確認でエラーが発生しました'
          );
        }
      } else if (tdsrId) {
        // three_d_secure_request を直接開けるケース（顧客カード3DSなど）:contentReference[oaicite:6]{index=6}
        await runThreeDSIframe(tdsrId);
        const finalizeRes = await fetchWithTimeout('/api/pay/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify(finalizePayload),
        });
        const finalize = await finalizeRes.json().catch(() => ({} as any));
        log('subscribe finalize response (TDSR)', { ok: finalizeRes.ok, finalize });
        if (!(finalizeRes.ok && finalize?.success) && !isAlreadySubscribed(finalize)) {
          const detail =
            finalize?.detail ||
            (Array.isArray(finalize?.missing) && finalize.missing.length ? `欠落フィールド: ${finalize.missing.join(', ')}` : '原因不明');
          throw new Error(detail || 'サブスク登録に失敗しました');
        }
      } else {
        throw new Error('3Dセキュア情報の取得に失敗しました（charge_id/tdsr_id/confirmation_url）');
      }

      setModalTitle('サブスク登録が完了しました');
      setModalMessage('ご利用ありがとうございます。');
      setModalOpen(true);
      await fetchStatus(true);
    } catch (err: any) {
      error('Subscription error:', err);
      setModalTitle('サブスク登録エラー');
      setModalMessage(String(err?.message || err));
      setModalOpen(true);
    } finally {
      setLoading(false);
    }
  };

  /* ---------- UI ---------- */
  return (
    <main className="pay-main">
      <h1 className="pay-title">ご利用プラン</h1>

      <section className="mt-2 rounded-xl border border-gray-200 p-3 bg-white">
        <div className="text-sm text-gray-800">
          <b>現在のプラン</b>：{userData?.plan_status ?? 'free'}
          {userData?.click_type ? <span className="text-gray-500">（click_type: {userData.click_type}）</span> : null}
        </div>
        <div className="text-sm text-gray-800 mt-1">
          <b>有効期限</b>：{userData?.plan_valid_until ? dayjs(userData.plan_valid_until).format('YYYY/MM/DD HH:mm') : '―'}
        </div>
        <div className="text-sm text-gray-800 mt-1">
          <b>クレジット残</b>：{userCredit}
        </div>
      </section>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => { log('onPlanSelected', plan); setSelectedPlan(plan); }}
      />

      {expired && (
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-900">
          ⚠ サブスクリプションの有効期限が切れています。プランを再購入してください。
        </div>
      )}

      {!cardRegistered && (
        <>
          {!showCardForm ? (
            <div className="text-center mt-4">
              <button
                className="btn-card-register"
                onClick={() => { log('open card form'); setShowCardForm(true); initPayjpCard(); }}
                disabled={loading}
              >
                カードを登録する
              </button>
            </div>
          ) : (
            <div>
              <CardStyle />
              <div className="text-center mt-4">
                <button onClick={handleCardRegistration} disabled={!cardReady || loading} className="btn-card-submit w-full">
                  {loading ? 'カード登録中…' : 'このカードを登録する'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {cardRegistered && (
        <>
          <div className="registered-card-box text-center">
            <p className="text-gray-700">💳 登録済みカード: {userData?.card_brand || 'VISA'} **** {userData?.card_last4 || '****'}</p>
          </div>

          <div className="text-center mt-4">
            <button className="btn-subscribe w-full" onClick={handleSubscribe} disabled={!selectedPlan || loading}>
              {loading ? '処理中…' : expired ? 'プランを再購入する' : 'プランを購入する'}
            </button>
          </div>
        </>
      )}

      <section className="mt-6">
        <h2 className="text-base font-semibold">プラン履歴</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-600 mt-2">履歴はまだありません。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {history.map((h, i) => (
              <li key={i} className="rounded-xl border border-gray-200 p-3 bg-white">
                <div className="text-sm">
                  <b>{dayjs(h.started_at).format('YYYY/MM/DD HH:mm')}</b>
                  {h.ended_at ? ` 〜 ${dayjs(h.ended_at).format('YYYY/MM/DD HH:mm')}` : ' 〜 現在'}
                </div>
                <div className="text-sm mt-1">
                  {h.from_plan_status || 'none'} → <b>{h.to_plan_status}</b>{' '}
                  <span className="text-gray-500">（click: {h.from_click_type || 'none'} → {h.to_click_type}）</span>
                </div>
                {(h.reason || h.source) && (
                  <div className="text-xs text-gray-500 mt-1">reason: {h.reason || '-'} / source: {h.source || '-'}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <PayResultModal open={modalOpen} title={modalTitle} message={modalMessage} onClose={() => setModalOpen(false)} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div>読み込み中...</div>}>
      <PageInner />
    </Suspense>
  );
}
