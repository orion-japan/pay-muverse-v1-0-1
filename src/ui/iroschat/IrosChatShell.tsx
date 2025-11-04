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

import './IrosChat.css';
import { useIrosChat } from './IrosChatContext'; // Providerは読み込まない

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

function IrosChatInner({ open }: Props) {
  const sp = useSearchParams();
  const urlCid = sp?.get('cid') ?? undefined;

  const agentK = 'iros';
  const { loading: authLoading, userCode } = useAuth();

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [uiUser, setUiUser] = useState<CurrentUser>();
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
    const set = (k: string, v: string) => document.documentElement.style.setProperty(k, v);
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
    const set = () =>
      document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ==== Iros Context ====
  const chat = useIrosChat();

  // openパラメータ（menu/new/cid）の一回処理（ループ防止）
  const didHandleOpenRef = useRef(false);
  useEffect(() => {
    if (didHandleOpenRef.current) return;
    if (!canUse) return;

    if (openTarget.type === 'menu') {
      setIsMobileMenuOpen(true);
      didHandleOpenRef.current = true;
      return;
    }

    if (openTarget.type === 'new') {
      try {
        window.localStorage.removeItem(lastConvKey(agentK));
      } catch {}
      // 新規会話を確実に発番
      chat.newConversation?.();
      didHandleOpenRef.current = true;
      return;
    }

    if ((openTarget.type === 'cid' || openTarget.type === 'uuid') && openTarget.cid) {
      // 既存会話に切替（存在確認は select 内で失敗時クリーンに）
      chat.selectConversation?.(openTarget.cid);
      try {
        window.localStorage.setItem(lastConvKey(agentK), openTarget.cid);
      } catch {}
      didHandleOpenRef.current = true;
      return;
    }
  }, [canUse, chat, openTarget]);

  // 初期選択（open 指定が無い通常遷移時）
  const didSelectOnce = useRef(false);
  useEffect(() => {
    if (!canUse) return;
    if (didSelectOnce.current) return;
    if (!chat.conversations.length) return;

    // open が何かを処理済みならスキップ
    if (didHandleOpenRef.current) return;

    const sorted = [...chat.conversations].sort((a, b) => {
      const ta = new Date(a.updated_at || 0).getTime();
      const tb = new Date(b.updated_at || 0).getTime();
      return tb - ta;
    });

    const stored =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(lastConvKey(agentK)) || undefined
        : undefined;

    const prefer =
      (urlCid && sorted.find((i) => i.id === urlCid)?.id) ||
      (stored && sorted.find((i) => i.id === stored)?.id) ||
      sorted[0]?.id;

    if (prefer) {
      didSelectOnce.current = true;
      chat.selectConversation(prefer);
      try {
        window.localStorage.setItem(lastConvKey(agentK), prefer);
      } catch {}
    }
  }, [canUse, chat.conversations, chat, urlCid]);

  // ユーザー情報
  useEffect(() => {
    if (!userCode) return;
    setUiUser({ id: userCode, name: 'You', userType: 'member', credits: 0 });
  }, [userCode]);

  const handleDelete = async () => {
    if (chat.conversationId) await chat.remove();
  };
  const handleRename = async () => {};

  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <IrosHeader
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={() => {
            try {
              window.localStorage.removeItem(lastConvKey(agentK));
            } catch {}
            chat.newConversation?.(); // ← ここで必ず新規発番
          }}
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }}
        aria-hidden
      />

      {authLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>読み込み中…</div>
      ) : !userCode ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
          ログインが必要です
        </div>
      ) : (
        <>
          {/* ====== ここからチャット本体（白い下地＋右端の紫ライン付き） ====== */}
          <div className="iro-chat-main">
            {/* 背景ガード（白ベース＋縦グラデーションライン） */}
            <div className="iro-chat-bg" />

            <IrosSidebarMobile
              isOpen={isMobileMenuOpen}
              onClose={() => setIsMobileMenuOpen(false)}
              conversations={chat.conversations}
              onSelect={(id) => {
                chat.selectConversation(id);
                setIsMobileMenuOpen(false);
                try {
                  window.localStorage.setItem(lastConvKey(agentK), id);
                } catch {}
              }}
              onDelete={handleDelete}
              onRename={handleRename}
              userInfo={uiUser ?? null}
              meta={meta as any}
            />

            <MessageList />

            <div className="sof-compose-dock" ref={composeRef}>
              <ChatInput />
            </div>
          </div>
          {/* ====== /チャット本体 ====== */}
        </>
      )}

      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
}

export default function IrosChatShell(props: Props) {
  // Providerは IrosChat.tsx 側のみでラップする
  return <IrosChatInner {...props} />;
}
