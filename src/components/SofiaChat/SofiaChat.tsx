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

type Agent = 'mu' | 'iros' | 'mirra';
type SofiaChatProps = { agent?: string };
const normalizeAgent = (a?: string): Agent => {
  const s = (a ?? '').toLowerCase();
  if (s.startsWith('mu')) return 'mu';
  if (s.startsWith('mirra') || s === 'm' || s === 'mr') return 'mirra';
  return 'iros';
};

export default function SofiaChat({ agent: agentProp = 'mu' }: SofiaChatProps) {
  const params = useSearchParams();
  const urlAgent = (params?.get('agent') as Agent | null) ?? null;
  const urlCid = params?.get('cid') ?? undefined;
  const urlFrom = params?.get('from') ?? undefined;
  const urlSummary = params?.get('summary_hint') ?? undefined;

  const agentK = normalizeAgent(urlAgent ?? agentProp);
  const { loading: authLoading, userCode } = useAuth();

  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  const [uiUser, setUiUser] = useState<{
    id: string;
    name: string;
    userType: string;
    credits: number;
    avatarUrl?: string | null;
  } | null>(null);

  const [mirraHistory, setMirraHistory] = useState<any[] | null>(null);

  const convIdByAgent = useRef<Record<Agent, string | undefined>>({
    mu: undefined,
    iros: undefined,
    mirra: undefined,
  });
  const msgsByAgent = useRef<Record<Agent, Message[]>>({
    mu: [],
    iros: [],
    mirra: [],
  });
  const loadAgentStateToView = useCallback((a: Agent) => {
    setConversationId(convIdByAgent.current[a]);
    setMessages(msgsByAgent.current[a] ?? []);
  }, []);
  const saveViewStateToAgent = useCallback(
    (a: Agent, id?: string, msgs?: Message[]) => {
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

  // ==== UI env → CSS
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

  // 見た目のホットフィックス
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
      box-shadow: 0 1px 0 rgba(107,140,255,.22) !important;
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

  // 送信中オーバーレイ抑止
  useEffect(() => {
    let el = document.getElementById('sofia-hide-overlay') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'sofia-hide-overlay';
      document.head.appendChild(el);
    }
    el.textContent = `.sof-overlay{ display:none !important; }`;
  }, []);

  // Compose高さ → CSS変数
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

  // ======== mTalk 要約の遅延注入
  const mtalkSeedRef = useRef<string | null>(null);
  const injectMtalkSeed = useCallback((rows: Message[], convId?: string): Message[] => {
    const seed = mtalkSeedRef.current;
    if (!seed) return rows;
    if (rows.length && (rows[0] as any)?.meta?.from === 'mtalk') return rows;
    const sysMsg: Message = {
      id: `mtalk-seed-${convId || Date.now()}`,
      role: 'system',
      content: `【mTalkからの共有】\n${seed}`,
      created_at: new Date().toISOString(),
      meta: { from: 'mtalk' },
      free: true,
    };
    mtalkSeedRef.current = null;
    return [sysMsg, ...rows];
  }, []);

  // mTalkからの遷移なら seed を保持
  useEffect(() => {
    if (urlFrom !== 'mtalk') return;

    if (urlCid) {
      convIdByAgent.current[agentK] = urlCid;
      setConversationId(urlCid);
    }

    let seed = '';
    if (typeof window !== 'undefined' && urlCid) {
      const ss = sessionStorage.getItem(`mtalk:seed:${urlCid}`);
      if (ss) seed = ss;
    }
    if (!seed && urlSummary) seed = decodeURIComponent(urlSummary);
    if (seed && typeof window !== 'undefined' && urlCid) {
      try { sessionStorage.removeItem(`mtalk:seed:${urlCid}`); } catch {}
    }
    if (seed) mtalkSeedRef.current = seed;
  }, [agentK, urlFrom, urlCid, urlSummary]);

  /* ===== 会話一覧 ===== */
// ← そのまま上は触らずに…

const fetchConversations = async () => {
  if (!userCode) return;

  // --- Mu ---------------------------------------------------------
  if (agentK === 'mu') {
    const r =
      (await fetchWithIdToken('/api/mu/list').catch(() => null)) ||
      (await fetchWithIdToken('/api/agent/muai/list').catch(() => null)); // 後方互換
    if (!r || !r.ok) throw new Error(`mu list ${r?.status ?? 'noresp'}`);

    const js: any = await r.json().catch(() => ({}));
    const muItems: ConvListItem[] = ((js.items ?? []) as any[])
      .map((x) => ({
        id: String(x.id ?? x.master_id ?? ''),
        title: String(x.title ?? 'Mu 会話'),
        updated_at: x.updated_at ?? null,
      }))
      .filter((x) => x.id);

    setConversations(muItems);

    // 保存されている Mu の会話IDがあれば UI にだけ反映（自動選択しない）
    const currentMu = convIdByAgent.current.mu;
    if (currentMu) setConversationId(currentMu);
    return;
  }

  // --- mirra ------------------------------------------------------
  if (agentK === 'mirra') {
    // mirra は会話一覧を持たない（固定ID）／履歴は別APIでサイドバー表示用に取得
    setConversations([]);

    if (!convIdByAgent.current.mirra) {
      convIdByAgent.current.mirra = `mirra-${userCode}`;
    }
    setConversationId(convIdByAgent.current.mirra);

    // 参考: 分析履歴（conversations 相当）
    try {
      const r2 = await fetchWithIdToken('/api/agent/mtalk/conversations', { cache: 'no-store' });
      const j2 = await r2.json().catch(() => ({}));
      setMirraHistory(Array.isArray(j2?.items) ? j2.items : []);
    } catch {
      setMirraHistory([]);
    }
    return;
  }

  // --- Iros -------------------------------------------------------
  const r = await fetchWithIdToken(
    `/api/sofia?user_code=${encodeURIComponent(userCode)}`
  );
  if (!r.ok) throw new Error(`list ${r.status}`);

  const js: SofiaGetList = await r.json().catch(() => ({}));
  const irosItems: ConvListItem[] = (js.items ?? []).map((row) => ({
    id: row.conversation_code,
    title:
      row.title ??
      (row.updated_at ? `会話 (${new Date(row.updated_at).toLocaleString()})` : '新しい会話'),
    updated_at: row.updated_at ?? null,
  }));

  setConversations(irosItems);

  // Iros は従来通りの自動選択
  const currentIros = convIdByAgent.current.iros;
  if (!currentIros && irosItems[0]?.id) {
    convIdByAgent.current.iros = irosItems[0].id;
    setConversationId(irosItems[0].id);
  } else if (currentIros) {
    setConversationId(currentIros);
  }
};


  /* ===== メッセージ ===== */
  const fetchMessages = async (convId: string) => {
    if (!userCode || !convId) return;
    try {
      if (agentK === 'mu') {
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

      if (agentK === 'mirra') {
        // 新: messages API（messages or items どちらでも受ける）
        const r = await fetchWithIdToken(
          `/api/agent/mtalk/messages?conversation_id=${encodeURIComponent(convId)}`,
          { cache: 'no-store' }
        );
        if (!r.ok) throw new Error(`mirra messages ${r.status}`);
        const j: any = await r.json().catch(() => ({}));

        const raw = Array.isArray(j?.messages)
          ? j.messages
          : Array.isArray(j?.items)
          ? j.items
          : [];

        const rows: Message[] = raw.map((m: any, i: number) => ({
          id: String(m.id ?? `${i}-${m.role}-${String(m.content ?? '').slice(0, 8)}`),
          role: (m.role as Role) ?? 'assistant',
          content: String(m.content ?? ''),
          created_at: m.created_at ?? undefined,
          meta: m.meta ?? undefined,
        }));

        // ★ mTalk seed（要約）を先頭に注入（初回のみ）
        const withSeed = injectMtalkSeed(rows, convId);

        setMessages(withSeed);
        saveViewStateToAgent('mirra', convId, withSeed);
        return;
      }


      // Iros
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

  // --- endpoint util ---
  const endpointFor = (a: Agent) => {
    if (a === 'mu') return '/api/agent/muai';
    if (a === 'mirra') return '/api/agent/mtalk';
    return '/api/sofia';
  };

  const mirraEndpoints = (tid: string, text: string, code: string) => [
    { url: '/api/agent/mtalk',         body: { text, thread_id: tid, user_code: code } }, // 公式
    { url: '/api/mtalk/mirra',         body: { text, thread_id: tid, user_code: code } }, // 旧
    { url: '/api/agent/mtalk/message', body: { text, thread_id: tid, user_code: code } }, // 互換
    { url: '/api/talk',                body: { text, threadId: tid, thread_id: tid, user_code: code } }, // 最後のフォールバック
  ];

  /* ===== 送信（mu / iros / mirra 切替） ===== */
  const handleSend = async (input: string, _files: File[] | null = null): Promise<void> => {
    const text = (input ?? '').trim();
    if (!text || !userCode) return;

    if (agentK === 'mirra' && !conversationId) {
      const seedId = `mirra-${userCode}`;
      setConversationId(seedId);
      saveViewStateToAgent('mirra', seedId, undefined);
    }

    const optimistic: Message = {
      id: crypto.randomUUID?.() ?? `tmp-${Date.now()}`,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      isPreview: true,
    };
    setMessages((prev) => {
      const next = [...prev, optimistic];
      saveViewStateToAgent(agentK, conversationId ?? undefined, next);
      return next;
    });

    try {
      let r: Response | null = null;
      let js: any = null;
      let nextConvId = conversationId;

      if (agentK === 'mirra') {
        const tid = conversationId ?? `mirra-${userCode}`;
        const candidates = mirraEndpoints(tid, text, userCode);
        for (const { url, body } of candidates) {
          try {
            r = await fetchWithIdToken(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
              body: JSON.stringify(body),
            });
          } catch {
            r = null;
          }
          if (!r || r.status === 401 || r.status === 404) continue;

          js = {};
          try { js = await r.json(); } catch {
            try { const t = await r.text(); if (t) js = { reply: t }; } catch {}
          }
          nextConvId = nextConvId ?? tid;
          break;
        }
        if (!r || r.status === 401 || r.status === 404) {
          window.dispatchEvent(new CustomEvent('toast', { detail: { kind: 'warn', msg: 'mirra送信に失敗しました（認証/エンドポイント不一致）。' } }));
          return;
        }
      } else if (agentK === 'mu') {
        const subId = crypto.randomUUID?.() ?? `sub-${Date.now()}`;
        r = await fetchWithIdToken(endpointFor('mu'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            master_id: conversationId ?? undefined,
            sub_id: subId,
            thread_id: null,
            board_id: null,
            source_type: 'chat',
          }),
        });
        js = {};
        try { js = await r.json(); } catch { try { js = { reply: await r.text() }; } catch {} }
        nextConvId = js?.conversation_id ?? conversationId;
      } else {
        r = await fetchWithIdToken(endpointFor('iros'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_code: conversationId ?? '',
            mode: 'normal',
            messages: [
              ...messages.map((m) => ({ role: m.role, content: m.content })),
              { role: 'user', content: text },
            ],
          }),
        });
        js = {};
        try { js = await r.json(); } catch { try { js = { reply: await r.text() }; } catch {} }
        nextConvId = js?.conversation_code ?? conversationId;
      }

      // 共通
      if (agentK === 'mirra') {
        const tid = conversationId ?? `mirra-${userCode}`;
        nextConvId = js?.conversation_id || js?.thread_id || js?.threadId || nextConvId || tid;
      }

      if (nextConvId && nextConvId !== conversationId) {
        setConversationId(nextConvId);
        saveViewStateToAgent(agentK, nextConvId, undefined);
        setConversations((prev) =>
          prev.some((x) => x.id === nextConvId)
            ? prev
            : [
                {
                  id: nextConvId,
                  title: agentK === 'mu' ? 'Mu 会話' : agentK === 'mirra' ? 'mirra 会話' : 'Iros 会話',
                  updated_at: new Date().toISOString(),
                },
                ...prev,
              ]
        );
      }

      let replyText =
        typeof js?.reply === 'string'
          ? js.reply
          : typeof js?.reply_text === 'string'
          ? js.reply_text
          : typeof js?.message === 'string'
          ? js.message
          : typeof js === 'string'
          ? js
          : '';

          if (agentK === 'mirra') {
            const tid = nextConvId ?? conversationId;
            if (!replyText && tid) {
              // 応答が空でもサーバ側が保存していれば、再取得で反映
              const r2 = await fetchWithIdToken(
                `/api/agent/mtalk/messages?conversation_id=${encodeURIComponent(tid)}`,
                { cache: 'no-store' }
              );
              const j2: any = await r2.json().catch(() => ({}));
    
              const raw2 = Array.isArray(j2?.messages)
                ? j2.messages
                : Array.isArray(j2?.items)
                ? j2.items
                : [];
    
              const rows2: Message[] = raw2.map((m: any, i: number) => ({
                id: String(m.id ?? `${i}-${m.role}-${String(m.content ?? '').slice(0, 8)}`),
                role: (m.role as Role) ?? 'assistant',
                content: String(m.content ?? ''),
                created_at: m.created_at ?? undefined,
                meta: m.meta ?? undefined,
              }));
    
              const withSeed2 = injectMtalkSeed(rows2, tid);
    
              if (withSeed2.length) {
                setMessages(withSeed2);
                saveViewStateToAgent('mirra', tid, withSeed2);
              }
            }
          }
    

      if (replyText) {
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: crypto.randomUUID?.() ?? `a-${Date.now()}`,
              role: 'assistant',
              content: replyText,
              created_at: new Date().toISOString(),
              agent: agentK,
              ...(js?.meta ? { meta: js.meta } : {}),
            } as any,
          ];
          saveViewStateToAgent(agentK, nextConvId ?? conversationId, next);
          return next;
        });
      }

      if (js?.meta) {
        const m = normalizeMeta(js.meta);
        if (m) setMeta(m);
      }

      if (typeof js?.credit_balance === 'number') {
        try {
          window.dispatchEvent(new CustomEvent('sofia_credit', { detail: { credits: js.credit_balance } }));
        } catch {}
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

  // mTalk要約を初回入力として自動送信（1回だけ）
  const autoAskedRef = useRef(false);
  useEffect(() => {
    if (urlFrom !== 'mtalk' || autoAskedRef.current) return;
    const hasSeed = messages.some((m) => m.meta?.from === 'mtalk');
    const hasAssistantReply = messages.some((m) => m.role === 'assistant' && !m.meta?.from);
    if (hasSeed && !hasAssistantReply) {
      autoAskedRef.current = true;
      // トーンは agent で切替
      handleSend(
        agentK === 'mu'
          ? '上のmTalk要約を前提に、実用寄り600字前後でお願いします。'
          : '上のmTalk要約を前提に、800字以上で「未消化の闇＝根っこにある恐れ・意味づけ」を丁寧に言語化するマインドトーク寄りの鑑定を書いてください。1) 反復している自動思考の台本を具体的な台詞で再現（例：「今日は何もできなかった→やはり私は価値がない」）。2) その台本が生まれた背景仮説（幼少期の評価軸、比較癖、見捨てられ不安等）と、身体感覚の連動（胸部の締めつけ、喉のつかえ等）。3) 思考と自分の〈距離をとる〉手順（命名→観察→3呼吸→再選択）。4) 反復停止のための“儀式”を提案（夜1分のセルフトーク書き換え／RAIN／内なるパーツへの一言など）。5) 同じ型で再発する出来事の例を2–3件挙げ、「このパターンを解ければマインドトークは静まる」まで導いてください。最後に、今夜できる1つの小さな実験で締めてください。'
      );
    }
  }, [messages, urlFrom, agentK]);

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

  const handleDelete = async (id: string) => {
    if (!userCode || !id) return;
    
    try {
      if (agentK === 'mu') {
        // Mu会話の削除APIを呼び出し
        await fetchWithIdToken(`/api/mu/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: id }),
        });
      } else if (agentK === 'mirra') {
        // mirra会話の削除APIを呼び出し
        await fetchWithIdToken(`/api/agent/mtalk/conversations/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } else {
        // Iros会話の削除APIを呼び出し
        await fetchWithIdToken(`/api/sofia/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_code: id }),
        });
      }

      // ローカル状態を更新
      setConversations(prev => prev.filter(conv => conv.id !== id));
      
      // 削除された会話が現在選択中の会話の場合、新しい会話を選択
      if (id === conversationId) {
        const remaining = conversations.filter(conv => conv.id !== id);
        if (remaining.length > 0) {
          handleSelectConversation(remaining[0].id);
        } else {
          handleNewChat();
        }
      }
    } catch (e) {
      console.error('[SofiaChat] delete error:', e);
      window.dispatchEvent(new CustomEvent('toast', { 
        detail: { kind: 'error', msg: '会話の削除に失敗しました' } 
      }));
    }
  };

  const handleRename = async (id: string, newTitle: string) => {
    if (!userCode || !id || !newTitle.trim()) return;
    
    try {
      if (agentK === 'mu') {
        // Mu会話のリネームAPIを呼び出し
        await fetchWithIdToken(`/api/mu/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: id, title: newTitle.trim() }),
        });
      } else if (agentK === 'mirra') {
        // mirra会話のリネームAPIを呼び出し
        await fetchWithIdToken(`/api/agent/mtalk/conversations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle.trim() }),
        });
      } else {
        // Iros会話のリネームAPIを呼び出し
        await fetchWithIdToken(`/api/sofia/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_code: id, title: newTitle.trim() }),
        });
      }

      // ローカル状態を更新
      setConversations(prev => 
        prev.map(conv => 
          conv.id === id 
            ? { ...conv, title: newTitle.trim() }
            : conv
        )
      );
    } catch (e) {
      console.error('[SofiaChat] rename error:', e);
      window.dispatchEvent(new CustomEvent('toast', { 
        detail: { kind: 'error', msg: '会話のリネームに失敗しました' } 
      }));
    }
  };

  // Name/Type/Credits クリック（受け取り→トースト）
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

  // 実ユーザー情報（get-user-info）
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
          setUiUser({ id: userCode, name: userCode, userType: 'free', credits: 0, avatarUrl: '/avatar.png' });
        }
      } catch {
        setUiUser({ id: userCode, name: userCode, userType: 'free', credits: 0, avatarUrl: '/avatar.png' });
      }
    })();
  }, [userCode]);

  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <Header
          agent={agentK}
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={handleNewChat}
        />
      </div>

      <div className="sof-top-spacer" style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }} aria-hidden />

      {authLoading ? (
        <div style={styles.center}>読み込み中…</div>
      ) : !userCode ? (
        <div style={styles.center}>ログインが必要です</div>
      ) : (
        <>
          <SidebarMobile
            agent={agentK}
            isOpen={isMobileMenuOpen}
            onClose={() => setIsMobileMenuOpen(false)}
            conversations={conversations}
            onSelect={(id) => {
              handleSelectConversation?.(id);
              setIsMobileMenuOpen(false);
            }}
            onDelete={handleDelete}
            onRename={handleRename}
            userInfo={
              uiUser ?? { id: userCode, name: userCode, userType: 'free', credits: 0 }
            }
            meta={meta}
            mirraHistory={agentK === 'mirra' ? mirraHistory ?? [] : undefined}
          />

          <MessageList messages={messages} currentUser={uiUser ?? undefined} agent={agentK} />

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
