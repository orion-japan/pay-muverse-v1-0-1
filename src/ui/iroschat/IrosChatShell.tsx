// src/ui/iroschat/IrosChatShell.tsx
'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { SOFIA_CONFIG } from '@/lib/sofia/config';
import IrosSidebarMobile from './IrosSidebarMobile';
import IrosHeader from './IrosHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import IrosMetaBadge from './components/IrosMetaBadge';

import './IrosChat.css';
import { useIrosChat } from './IrosChatContext';

type CurrentUser = {
  id: string;
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;
};
type Props = { open?: string };

type OpenTarget =
  | { type: null; cid?: undefined }
  | { type: 'menu'; cid?: undefined }
  | { type: 'new'; cid?: undefined }
  | { type: 'cid'; cid: string }
  | { type: 'uuid'; cid: string };

const lastConvKey = (agent: string) => `sofia:lastConv:${agent}`;

// 未来Seedボタン用のカスタムイベント名
const FUTURE_SEED_EVENT = 'iros:future-seed';

function IrosChatInner({ open }: Props) {
  const sp = useSearchParams();
  const urlCid = sp?.get('cid') ?? undefined;

  const agentK = 'iros';
  const { loading: authLoading, userCode } = useAuth();

  // ★ 初期は必ず閉じた状態
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [uiUser, setUiUser] = useState<CurrentUser | null>(null);
  const [meta, setMeta] = useState<any>(null);

  const composeRef = useRef<HTMLDivElement | null>(null);
  const canUse = useMemo(() => !!userCode && !authLoading, [userCode, authLoading]);

  const openTarget: OpenTarget = useMemo(() => {
    if (!open) return { type: null, cid: undefined };
    if (open === 'menu') return { type: 'menu', cid: undefined };
    if (open === 'new') return { type: 'new', cid: undefined };
    if (open.startsWith('cid:')) return { type: 'cid', cid: open.slice(4) };
    return { type: 'uuid', cid: open };
  }, [open]);

  // テーマ設定（CSS変数）
  useEffect(() => {
    const ui = ((SOFIA_CONFIG as any)?.ui ?? {}) as Record<string, any>;
    const get = <T,>(v: T | undefined, d: T) => v ?? d;
    const set = (k: string, v: string) => {
      try {
        document.documentElement.style.setProperty(k, v);
      } catch {}
    };
    set('--sofia-container-maxw', `${get(ui.containerMaxWidth, 840)}px`);
    set('--sofia-bubble-maxw', `${get(ui.bubbleMaxWidthPct, 88)}%`);
    set('--sofia-a-border', get(ui.assistantBorder, '1px solid rgba(255,255,255,0.08)'));
    set('--sofia-a-radius', `${get(ui.assistantRadius, 14)}px`);
    set('--sofia-a-shadow', get(ui.assistantShadow, '0 4px 24px rgba(0,0,0,0.25)'));
    set('--sofia-a-bg', get(ui.assistantBg, 'rgba(255,255,255,0.04)'));
    set('--sofia-bq-border', get(ui.blockquoteTintBorder, '1px solid rgba(160,200,255,0.25)'));
    set('--sofia-bq-bg', get(ui.blockquoteTintBg, 'rgba(160,200,255,0.06)'));
    set('--sofia-user-bg', get(ui.userBg, 'rgba(0,0,0,0.25)'));
    set('--sofia-user-fg', get(ui.userFg, '#fff'));
    set('--sofia-user-border', get(ui.userBorder, '1px solid rgba(255,255,255,0.08)'));
    set('--sofia-user-radius', `${get(ui.userRadius, 14)}px`);
  }, []);

  // Compose 高さをCSS変数に反映
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const setter = () => {
      try {
        document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
      } catch {}
    };
    setter();

    const RO: typeof ResizeObserver | undefined =
      typeof window !== 'undefined' ? (window as any).ResizeObserver : undefined;
    if (!RO) return;

    const ro = new RO(setter);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch {}
    };
  }, []);

  // ==== Iros Context ====
  const chat = useIrosChat();
  // ✅ DEBUG: cid 追従確認（確証取り・後で消す）
  useEffect(() => {
    try {
      console.log('[IROS][Shell][CID_DEBUG]', {
        urlCid,
        open,
        openTarget,
        canUse,
        didInitialFetch: didInitialFetchRef.current,
        activeConversationId: chat?.activeConversationId ?? null,
      });
    } catch {}
  }, [urlCid, open, canUse, chat, openTarget]);

  // Context 側の userInfo をローカル表示用に同期
  useEffect(() => {
    if (!chat) return; // chat がまだ null のタイミングをケア

    const ui = (chat as any).userInfo ?? null;
    setUiUser(ui);
  }, [chat]);


  // === 未来Seed（β）ボタンからのトリガーをハンドリング ===
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = async () => {
      if (!userCode || authLoading) return;

      try {
        // アクティブな会話がなければ新規作成
        let cid = chat.activeConversationId;
        if (!cid) {
          cid = await chat.newConversation();
        }

        // 送るプロンプト（ここはあとで自由に調整OK）
        const seedPrompt =
          '【未来Seed】\n' +
          'いまの私の「未来の種（Seed）」をみてください。\n' +
          '1. その種は、どんな「未来の景色」につながっていますか？\n' +
          '2. そこに至るまで、どんな「努力」や「プロセス」が育っていきますか？\n' +
          '3. その結果として、どんな「実り」や「成功」が手の中に残りますか？\n' +
          'Iros の視点で、静かに描写してください。';

        await chat.sendMessage(seedPrompt, 'future_seed');
      } catch (e) {
        console.warn('[IrosChatInner] future-seed handler error:', e);
      }
    };

    window.addEventListener(FUTURE_SEED_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(FUTURE_SEED_EVENT, handler as EventListener);
    };
  }, [chat, userCode, authLoading]);

  // 初回オープン/初期選択（フェッチは必ず1回だけ）
  const didInitialFetchRef = useRef(false);

  useEffect(() => {
    if (!canUse) return;
    if (didInitialFetchRef.current) return;

    const convs = Array.isArray(chat.conversations) ? chat.conversations : [];

    // ====== 1) openTarget: new ======
    if (openTarget.type === 'new') {
      didInitialFetchRef.current = true; // ✅ 先に立てる（競合防止）
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(lastConvKey(agentK));
        }
      } catch {}
      chat.startConversation().catch(() => {});
      return;
    }

    // ====== 2) openTarget: cid/uuid ======
    if ((openTarget.type === 'cid' || openTarget.type === 'uuid') && openTarget.cid) {
      didInitialFetchRef.current = true; // ✅ 先に立てる（競合防止）
      chat
        .fetchMessages(openTarget.cid)
        .catch(() => {})
        .finally(() => {
          try {
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(lastConvKey(agentK), openTarget.cid!);
            }
          } catch {}
        });
      return;
    }

    // ====== 3) open指定が無い通常遷移（conversations が揃ってから決める） ======
    if (!convs.length) return; // convs が無いと決められないので待つ

    // URL の cid が優先
    if (urlCid) {
      const exists = convs.some((c) => c.id === urlCid);
      if (exists) {
        didInitialFetchRef.current = true; // ✅ 先に立てる（競合防止）
        chat.fetchMessages(urlCid).catch(() => {});
        return;
      }
    }

    // localStorage の lastConv
    let lastId: string | null = null;
    try {
      if (typeof window !== 'undefined') {
        lastId = window.localStorage.getItem(lastConvKey(agentK));
      }
    } catch {}

    if (lastId) {
      const exists = convs.some((c) => c.id === lastId);
      if (exists) {
        didInitialFetchRef.current = true; // ✅ 先に立てる（競合防止）
        chat.fetchMessages(lastId).catch(() => {});
        return;
      }
    }

    // それでも決まらなければ、最新の会話
    const latest = convs[0];
    if (latest?.id) {
      didInitialFetchRef.current = true; // ✅ 先に立てる（競合防止）
      chat.fetchMessages(latest.id).catch(() => {});
      return;
    }
  }, [canUse, chat, chat.conversations, openTarget, urlCid, agentK]);


  const handleDelete = async () => {
    const cid = chat.activeConversationId;
    if (!cid) return;
    try {
      await chat.deleteConversation(cid);
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(lastConvKey(agentK));
        }
      } catch {}
    } catch {
      // noop
    }
  };

  const handleRename = async () => {
    // まだ未実装
  };

  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <IrosHeader
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={() => {
            try {
              if (typeof window !== 'undefined') {
                window.localStorage.removeItem(lastConvKey(agentK));
              }
            } catch {}
            chat.startConversation().catch(() => {});
          }}
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 25px) + 3px)' }}
        aria-hidden
      />

      {authLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
          読み込み中…
        </div>
      ) : !userCode ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
          ログインが必要です
        </div>
      ) : (
        <>
          <div className="iro-chat-main">
            <div className="iro-chat-bg" />

            {/* 右上メタ表示 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                padding: '6px 12px 0',
                position: 'relative',
                zIndex: 3,
              }}
            >
              <IrosMetaBadge qCode={meta?.qCode} depth={meta?.depth} mode={meta?.mode} compact />
            </div>

            <IrosSidebarMobile
              isOpen={isMobileMenuOpen}
              onClose={() => setIsMobileMenuOpen(false)}
              conversations={
                Array.isArray(chat.conversations)
                  ? (chat.conversations as any)
                  : []
              }
              onSelect={(id) => {
                chat.fetchMessages(id).catch(() => {});
                setIsMobileMenuOpen(false);
                try {
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem(lastConvKey(agentK), id);
                  }
                } catch {}
              }}
              onDelete={handleDelete}
              onRename={handleRename}
              userInfo={uiUser}
              meta={meta as any}
            />

            <MessageList />

            <div className="sof-compose-dock" ref={composeRef}>
              <ChatInput onMeta={setMeta} />
            </div>
          </div>
        </>
      )}

      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
}

export default function IrosChatShell(props: Props) {
  return <IrosChatInner {...props} />;
}
