// src/components/SofiaChat/SofiaChat.tsx
'use client';

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

import '@/components/SofiaChat/SofiaChat.css';
import './ChatInput.css';
import './SofiaResonance.css';

import SidebarMobile from './SidebarMobile';
import Header from './header';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import type { MetaData } from '@/components/SofiaChat/MetaPanel';
import Image from 'next/image';

/* ========= types ========= */
type Role = 'user' | 'assistant' | 'system';
export type Message = {
  id: string;
  role: Role;
  content: string;
  created_at?: string;
  isPreview?: boolean;
  meta?: any;
  free?: boolean;   // 課金対象外（mTalk共有用）
  agent?: string;   // 表示用
};

type ConvListItem = {
  id: string;
  title: string;
  updated_at?: string | null;
};

type SofiaGetList = {
  items?: {
    conversation_code: string;
    title?: string | null;
    updated_at?: string | null;
    messages?: { role: Role; content: string }[];
  }[];
};
type SofiaGetMessages = { messages?: { role: Role; content: string }[] };

type SofiaPostRes = {
  conversation_code?: string;
  conversation_id?: string;
  reply?: string;
  meta?: any;
};

/* ========= utils ========= */
const normalizeMeta = (m: any): MetaData | null => {
  if (!m) return null;
  const asArray = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
  const qcodes = asArray(m.qcodes).map((q: any) =>
    typeof q === 'string'
      ? { code: q }
      : { code: String(q?.code ?? q), score: typeof q?.score === 'number' ? q.score : undefined }
  );
  const layers = asArray(m.layers).map((l: any) =>
    typeof l === 'string'
      ? { layer: l }
      : { layer: String(l?.layer ?? l), score: typeof l?.score === 'number' ? l.score : undefined }
  );
  const used_knowledge = asArray(m.used_knowledge).map((k: any) => ({
    id: String(k?.id ?? `${k?.key ?? 'K'}-${Math.random().toString(36).slice(2, 7)}`),
    key: String(k?.key ?? 'K'),
    title: (k?.title ?? null) as string | null,
  }));
  const indicator = {
    on: typeof m.stochastic === 'boolean' ? m.stochastic : Boolean(m?.stochastic?.on),
    g: typeof m.g === 'number' ? m.g : m?.stochastic?.g ?? null,
    seed: typeof m.seed === 'number' ? m.seed : m?.stochastic?.seed ?? null,
    noiseAmp: typeof m.noiseAmp === 'number' ? m.noiseAmp : m?.stochastic?.noiseAmp ?? null,
    epsilon: m?.stochastic_params?.epsilon ?? null,
    retrNoise: m?.stochastic_params?.retrNoise ?? null,
    retrSeed: m?.stochastic_params?.retrSeed ?? null,
  };
  return { qcodes, layers, used_knowledge, stochastic: indicator };
};

/* ========= props / helpers ========= */
type SofiaChatProps = { agent?: string };
const normalizeAgent = (a?: string): 'mu' | 'iros' =>
  a && /^mu\b/i.test(a) ? 'mu' : 'iros';

export default function SofiaChat({ agent: agentProp = 'mu' }: SofiaChatProps) {
  const params = useSearchParams();
  const urlAgent = (params?.get('agent') as 'mu' | 'iros' | null) ?? null;
  const urlCid = params?.get('cid') ?? undefined;
  const urlFrom = params?.get('from') ?? undefined;
  const urlSummary = params?.get('summary_hint') ?? undefined;

  // URL の agent があれば優先して正規化
  const agentK = normalizeAgent(urlAgent ?? agentProp);

  const { loading: authLoading, userCode, planStatus } = useAuth();

  /* ========= states ========= */
  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  // ✅ Sidebar/MessageList 表示用：ユーザーの実値
  const [uiUser, setUiUser] = useState<{
    id: string;
    name: string;
    userType: string;
    credits: number;
    avatarUrl?: string | null;
  } | null>(null);

  // ========= agentごとに会話ID/メッセージを分離保持 =========
  const convIdByAgent = useRef<Record<'mu' | 'iros', string | undefined>>({
    mu: undefined,
    iros: undefined,
  });
  const msgsByAgent = useRef<Record<'mu' | 'iros', Message[]>>({
    mu: [],
    iros: [],
  });
  const loadAgentStateToView = useCallback((a: 'mu' | 'iros') => {
    setConversationId(convIdByAgent.current[a]);
    setMessages(msgsByAgent.current[a] ?? []);
  }, []);
  const saveViewStateToAgent = useCallback(
    (a: 'mu' | 'iros', id?: string, msgs?: Message[]) => {
      if (id !== undefined) convIdByAgent.current[a] = id;
      if (msgs !== undefined) msgsByAgent.current[a] = msgs;
    },
    []
  );
  useEffect(() => {
    loadAgentStateToView(agentK);
  }, [agentK, loadAgentStateToView]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const canUse = useMemo(() => !!userCode && !authLoading, [userCode, authLoading]);

  /* ==== UI用CSS変数（env → CSS） ==== */
  useEffect(() => {
    const ui = SOFIA_CONFIG.ui;
    const r = document.documentElement;
    const set = (k: string, v?: string | number) => {
      if (v === undefined || v === null) return;
      r.style.setProperty(k, String(v));
    };
    set('--sofia-assist-fs', `${ui.assistantFontSize}px`);
    set('--sofia-assist-lh', ui.assistantLineHeight);
    set('--sofia-assist-ls', `${ui.assistantLetterSpacing}em`);
    set('--sofia-p-margin', `${ui.paragraphMargin}px`);
    set('--sofia-bubble-maxw', `${ui.bubbleMaxWidthPct}%`);
    set('--sofia-a-border', ui.assistantBorder);
    set('--sofia-a-radius', `${ui.assistantRadius}px`);
    set('--sofia-a-shadow', ui.assistantShadow);
    set('--sofia-a-bg', ui.assistantBg);
    set('--sofia-bq-border', ui.blockquoteTintBorder);
    set('--sofia-bq-bg', ui.blockquoteTintBg);
    set('--sofia-user-bg', ui.userBg);
    set('--sofia-user-fg', ui.userFg);
    set('--sofia-user-border', ui.userBorder);
    set('--sofia-user-radius', `${ui.userRadius}px`);
  }, []);

  /* ==== プレゼン用 Hotfix ==== */
  useEffect(() => {
    const css = `
    :where(.sofia-container) .sof-msgs .sof-bubble{
      border: none !important;
      background:
        radial-gradient(130% 160% at 0% -40%, rgba(203,213,225,.28), transparent 60%),
        linear-gradient(180deg, #ffffff 0%, #f6f9ff 100%) !important;
      box-shadow: 0 1px 0 rgba(255,255,255,.65) inset, 0 8px 24px rgba(2,6,23,.10) !important;
      border-radius: var(--sofia-a-radius, 16px) !important;
    }
    :where(.sofia-container) .sof-msgs .sof-bubble.is-assistant{
      border-bottom-left-radius: 6px !important;
      color: #0f172a !important;
    }
    :where(.sofia-container) .sof-msgs .sof-bubble.is-user{
      color: #fff !important;
      text-shadow: 0 1px 0 rgba(0,0,0,.08);
      border: none !important;
      background: linear-gradient(180deg, #8aa0ff 0%, #6b8cff 60%, #5979ee 100%) !important;
      box-shadow: 0 1px 0 rgba(255,255,255,.25) inset, 0 10px 24px rgba(107,140,255,.22) !important;
      border-bottom-right-radius: 6px !important;
    }
    .sof-underlay{ background: transparent !important; box-shadow:none !important; }
    `;
    let el = document.getElementById('sofia-hotfix') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'sofia-hotfix';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, []);

  /* ==== 「送信中」オーバーレイを強制オフ ==== */
  useEffect(() => {
    let el = document.getElementById('sofia-hide-overlay') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'sofia-hide-overlay';
      document.head.appendChild(el);
    }
    el.textContent = `.sof-overlay{ display:none !important; }`;
  }, []);

  /* ===== Compose の高さ反映 ===== */
  const composeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const set = () => {
      document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.setProperty('--meta-height', `0px`);
  }, []);

  /* ======== mTalk 要約の遅延注入（重要） ======== */
  // 1回だけ履歴取得後に先頭へ差し込むための一時置き場
  const mtalkSeedRef = useRef<string | null>(null);

  // 履歴配列へ mTalk共有を先頭追加するヘルパー
  const injectMtalkSeed = useCallback((rows: Message[], convId?: string): Message[] => {
    const seed = mtalkSeedRef.current;
    if (!seed) return rows;
    if (rows.length && (rows[0] as any)?.meta?.from === 'mtalk') return rows; // 重複防止
    const sysMsg: Message = {
      id: `mtalk-seed-${convId || Date.now()}`,
      role: 'system',
      content: `【mTalkからの共有】\n${seed}`,
      created_at: new Date().toISOString(),
      meta: { from: 'mtalk' },
      free: true,
    };
    mtalkSeedRef.current = null; // 1回で使い切る
    return [sysMsg, ...rows];
  }, []);

  // mTalkからの遷移なら seed を ref に保持（ここでは挿入しない）
  useEffect(() => {
    if (urlFrom !== 'mtalk') return;

    // URL の会話IDを反映
    if (urlCid) {
      convIdByAgent.current[agentK] = urlCid;
      setConversationId(urlCid);
    }

    // まず sessionStorage の全文を読む → なければ URL の短縮版
    let seed = '';
    if (typeof window !== 'undefined' && urlCid) {
      const ss = sessionStorage.getItem(`mtalk:seed:${urlCid}`);
      if (ss) seed = ss;
    }
    if (!seed && urlSummary) {
      seed = decodeURIComponent(urlSummary);
    }

    if (seed && typeof window !== 'undefined' && urlCid) {
      try { sessionStorage.removeItem(`mtalk:seed:${urlCid}`); } catch {}
    }

    if (seed) mtalkSeedRef.current = seed;
  }, [agentK, urlFrom, urlCid, urlSummary]);

  /* ===== 会話一覧 ===== */
  const fetchConversations = async () => {
    if (!userCode) return;
    try {
      if (agentK === 'mu') {
        // Mu の一覧API
        const r =
          (await fetchWithIdToken('/api/mu/list').catch(() => null)) ||
          (await fetchWithIdToken('/api/agent/muai/list').catch(() => null)); // 後方互換
        if (!r || !r.ok) throw new Error(`mu list ${r?.status ?? 'noresp'}`);
        const js: any = await r.json().catch(() => ({}));
        const items = ((js.items ?? []) as any[])
          .map((x) => ({
            id: String(x.id ?? x.master_id ?? ''),
            title: String(x.title ?? 'Mu 会話'),
            updated_at: x.updated_at ?? null,
          }))
          .filter((x) => x.id);
        setConversations(items);

        // 保存されている Mu の会話IDがあれば UI にだけ反映（自動選択しない）
        const currentMu = convIdByAgent.current.mu;
        if (currentMu) setConversationId(currentMu);
        return;
      }

      // Iros（/api/sofia）
      const r = await fetchWithIdToken(`/api/sofia?user_code=${encodeURIComponent(userCode)}`);
      if (!r.ok) throw new Error(`list ${r.status}`);
      const js: SofiaGetList = await r.json().catch(() => ({}));

      const items = (js.items ?? []).map((row) => ({
        id: row.conversation_code,
        title:
          row.title ??
          (row.updated_at ? `会話 (${new Date(row.updated_at).toLocaleString()})` : '新しい会話'),
        updated_at: row.updated_at ?? null,
      })) as ConvListItem[];

      setConversations(items);

      // Iros は従来通りの自動選択
      const currentIros = convIdByAgent.current.iros;
      if (!currentIros && items[0]?.id) {
        convIdByAgent.current.iros = items[0].id;
        setConversationId(items[0].id);
      } else if (currentIros) {
        setConversationId(currentIros);
      }
    } catch (e) {
      console.error('[SofiaChat] fetchConversations error:', e);
    }
  };

  /* ===== メッセージ ===== */
  const fetchMessages = async (convId: string) => {
    if (!userCode || !convId) return;
    try {
      if (agentK === 'mu') {
        // Mu の履歴取得API
        const r = await fetchWithIdToken(`/api/mu/turns?conv_id=${encodeURIComponent(convId)}`);
        if (!r.ok) throw new Error(`mu turns ${r.status}`);
        const js: any = await r.json().catch(() => ({}));

        const rows = (js.items ?? []).map((m: any) => ({
          id: m.id,
          role: (m.role as Role) ?? 'assistant',
          content: m.content,
          created_at: m.created_at,
        })) as Message[];

        const withSeed = injectMtalkSeed(rows, convId);
        setMessages(withSeed);
        saveViewStateToAgent(agentK, conversationId, withSeed);
        return;
      }

      // Iros の履歴取得
      const r = await fetchWithIdToken(
        `/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(
          convId
        )}`
      );
      if (!r.ok) throw new Error(`messages ${r.status}`);
      const js: SofiaGetMessages = await r.json().catch(() => ({}));
      const rows = (js.messages ?? []).map((m, i) => ({
        id: `${i}-${m.role}-${m.content.slice(0, 8)}`,
        role: (m.role as Role) ?? 'assistant',
        content: m.content,
      })) as Message[];

      setMessages((prev) => {
        const map = new Map<string, Message>(prev.map((m) => [m.id, m]));
        for (const m of rows) map.set(m.id, m);
        const merged = Array.from(map.values());
        const withSeed = injectMtalkSeed(merged, convId);
        saveViewStateToAgent(agentK, conversationId, withSeed);
        return withSeed;
      });
    } catch (e) {
      console.error('[SofiaChat] fetchMessages error:', e);
    }
  };

  useEffect(() => {
    if (!canUse) return;
    fetchConversations();
  }, [canUse, userCode, agentK]);

  useEffect(() => {
    if (!canUse || !conversationId) return;
    fetchMessages(conversationId);
  }, [canUse, conversationId, agentK]);

  const endpointFor = (a: 'mu' | 'iros') => (a === 'mu' ? '/api/agent/muai' : '/api/sofia');

  /* ===== 送信（mu/iros 切替） ===== */
  const handleSend = async (input: string, _files: File[] | null = null): Promise<void> => {
    const text = (input ?? '').trim();
    if (!text || !userCode) return;

    const optimistic: Message = {
      id: crypto.randomUUID?.() ?? `tmp-${Date.now()}`,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => {
      const next = [...prev, optimistic];
      saveViewStateToAgent(agentK, conversationId, next);
      return next;
    });

    try {
      const url = endpointFor(agentK);
      let body: any;

      if (agentK === 'mu') {
        // MU は 1 発話ごと（親=master_id / 子=sub_id）
        const subId = crypto.randomUUID?.() ?? `sub-${Date.now()}`;
        body = {
          message: text,
          master_id: conversationId ?? undefined,
          sub_id: subId,
          thread_id: null,
          board_id: null,
          source_type: 'chat',
        };
      } else {
        // Iros は履歴バルク
        body = {
          conversation_code: conversationId ?? '',
          mode: 'normal',
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
          ],
        };
      }

      const r = await fetchWithIdToken(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const js: SofiaPostRes & any = await r.json().catch(() => ({}));

      // 会話ID更新（MU は conversation_id、Iros は conversation_code）
      const nextConvId =
        agentK === 'mu' ? js.conversation_id ?? body.master_id : js.conversation_code;
      if (nextConvId && nextConvId !== conversationId) {
        setConversationId(nextConvId);
        saveViewStateToAgent(agentK, nextConvId, undefined);
        setConversations((prev) =>
          prev.some((x) => x.id === nextConvId)
            ? prev
            : [
                {
                  id: nextConvId,
                  title: agentK === 'mu' ? 'Mu 会話' : 'Iros 会話',
                  updated_at: new Date().toISOString(),
                },
                ...prev,
              ]
        );
      }

      if (typeof js.reply === 'string') {
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: crypto.randomUUID?.() ?? `a-${Date.now()}`,
              role: 'assistant',
              content: js.reply,
              created_at: new Date().toISOString(),
              agent: agentK === 'mu' ? 'Mu' : 'Iros',
              ...(js?.meta ? { meta: js.meta } : {}),
            } as any,
          ];
          saveViewStateToAgent(agentK, conversationId, next);
          return next;
        });
      }

      if (js.meta) {
        const m = normalizeMeta(js.meta);
        if (m) setMeta(m);
      }

      if (typeof js.credit_balance === 'number') {
        window.dispatchEvent(
          new CustomEvent('sofia_credit', { detail: { credits: js.credit_balance } })
        );
        if (js.credit_balance < 1) {
          window.dispatchEvent(
            new CustomEvent('toast', {
              detail: { kind: 'warn', msg: '残りクレジットが少なくなっています。' },
            })
          );
        }
      }

      if (!r.ok && (r.status === 402 || js?.error === 'insufficient_credit')) {
        window.dispatchEvent(
          new CustomEvent('toast', {
            detail: { kind: 'warn', msg: '残高が不足しています。チャージをご確認ください。' },
          })
        );
      }
    } catch (e) {
      console.error('[SofiaChat] send error:', e);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID?.() ?? `e-${Date.now()}`,
          role: 'assistant',
          content: '（通信に失敗しました。時間をおいて再度お試しください）',
        },
      ]);
    }
  };

  /* ===== mTalk要約を初回入力として自動送信（1回だけ） ===== */
  const autoAskedRef = useRef(false);
  useEffect(() => {
    if (urlFrom !== 'mtalk' || autoAskedRef.current) return;
    const hasSeed = messages.some((m) => m.meta?.from === 'mtalk');
    const hasAssistantReply = messages.some((m) => m.role === 'assistant' && !m.meta?.from);
    if (hasSeed && !hasAssistantReply) {
      autoAskedRef.current = true;
      // トーンは agent で切替（Mu=実用600字 / Iros=深掘り800字以上）
      handleSend(
        agentK === 'mu'
          ? '上のmTalk要約を前提に、実用寄り600字前後でお願いします。'
          : '上のmTalk要約を前提に、800字以上で「未消化の闇＝根っこにある恐れ・意味づけ」を丁寧に言語化するマインドトーク寄りの鑑定を書いてください。1) 反復している自動思考の台本を具体的な台詞で再現（例：「今日は何もできなかった→やはり私は価値がない」）。2) その台本が生まれた背景仮説（幼少期の評価軸、比較癖、見捨てられ不安等）と、身体感覚の連動（胸部の締めつけ、喉のつかえ等）。3) 思考と自分の〈距離をとる〉手順（命名→観察→3呼吸→再選択）。4) 反復停止のための“儀式”を提案（夜1分のセルフトーク書き換え／RAIN／内なるパーツへの一言など）。5) 同じ型で再発する出来事の例を2–3件挙げ、「このパターンを解ければマインドトークは静まる」まで導いてください。最後に、今夜できる1つの小さな実験で締めてください。'
      );
      
    }
  }, [messages, urlFrom, agentK]);

  /* ===== その他 ===== */
  const handleNewChat = () => {
    convIdByAgent.current[agentK] = undefined;
    msgsByAgent.current[agentK] = [];
    setConversationId(undefined);
    setMessages([]);
    setMeta(null);
  };

  const handleSelectConversation = (id: string) => {
    convIdByAgent.current[agentK] = id;
    setConversationId(id);
    setIsMobileMenuOpen(false);
  };

  /* ===== サイドバー：リネーム / 削除 ===== */
  const handleRename = useCallback(async (id: string, newTitle: string) => {
    try {
      const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j?.error ?? 'リネームに失敗しました');
        return;
      }
      setConversations((xs) => xs.map((x) => (x.id === id ? { ...x, title: newTitle } : x)));
    } catch (e) {
      console.error('[SofiaChat] rename error:', e);
      alert('リネームに失敗しました');
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('この会話を削除します。よろしいですか？')) return;
      try {
        const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert(j?.error ?? '削除に失敗しました');
          return;
        }
        setConversations((xs) => xs.filter((x) => x.id !== id));
        if (conversationId === id) handleNewChat();
      } catch (e) {
        console.error('[SofiaChat] delete error:', e);
        alert('削除に失敗しました');
      }
    },
    [conversationId]
  );

  /* ===== Name/Type/Credits クリック（受け取り→トースト） ===== */
  useEffect(() => {
    const showToast = (msg: string) => {
      const id = 'sof-toast';
      document.getElementById(id)?.remove();
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText =
        'position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
        'background:rgba(0,0,0,.78);color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;' +
        'z-index:2147483647;box-shadow:0 6px 16px rgba(0,0,0,.18)';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1800);
    };

    const onName = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Username: ${d.name ?? d.id ?? ''}`);
    };
    const onType = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Type: ${d.userType ?? ''}`);
    };
    const onCredit = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Credits: ${d.credits ?? 0}`);
    };

    window.addEventListener('click_username', onName as EventListener);
    window.addEventListener('click_type', onType as EventListener);
    window.addEventListener('sofia_credit', onCredit as EventListener);

    return () => {
      window.removeEventListener('click_username', onName as EventListener);
      window.removeEventListener('click_type', onType as EventListener);
      window.removeEventListener('sofia_credit', onCredit as EventListener);
    };
  }, []);

  /* ===== 実ユーザー情報の取得（get-user-info） ===== */
  useEffect(() => {
    if (!userCode) return;
    (async () => {
      try {
        const r = await fetchWithIdToken('/api/get-user-info', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          setUiUser({
            id: j.user_code ?? userCode,
            name: j.click_username ?? j.user_code ?? userCode,
            userType: String(j.click_type ?? 'free'),
            credits: Number(j.sofia_credit ?? 0) || 0,
            avatarUrl: j.avatar_url ?? '/avatar.png',
          });
        } else {
          setUiUser({
            id: userCode,
            name: userCode,
            userType: 'free',
            credits: 0,
            avatarUrl: '/avatar.png',
          });
        }
      } catch {
        setUiUser({
          id: userCode,
          name: userCode,
          userType: 'free',
          credits: 0,
          avatarUrl: '/avatar.png',
        });
      }
    })();
  }, [userCode]);

  /* ========= render ========= */
  return (
    <div className="sofia-container sof-center">
      {/* ヘッダー */}
      <div className="sof-header-fixed">
        <Header
          agent={agentK}
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={handleNewChat}
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }}
        aria-hidden
      />

      {/* 本文 */}
      {authLoading ? (
        <div style={styles.center}>読み込み中…</div>
      ) : !userCode ? (
        <div style={styles.center}>ログインが必要です</div>
      ) : (
        <>
          <SidebarMobile
            isOpen={isMobileMenuOpen}
            onClose={() => setIsMobileMenuOpen(false)}
            conversations={conversations}
            onSelect={handleSelectConversation}
            onDelete={handleDelete}
            onRename={handleRename}
            userInfo={
              uiUser ?? {
                id: userCode,
                name: userCode,
                userType: 'free',
                credits: 0,
              }
            }
            meta={meta}
          />

          <MessageList
            messages={messages}
            currentUser={uiUser ?? undefined}
            agent={agentK}
          />

          <div ref={endRef} />

          <div className="sof-compose-dock" ref={composeRef}>
            <ChatInput onSend={(text) => handleSend(text, null)} />
          </div>
        </>
      )}

      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: { display: 'grid', placeItems: 'center', minHeight: '60vh' },
};
