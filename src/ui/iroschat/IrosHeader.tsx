// src/ui/iroschat/IrosHeader.tsx
'use client';

import React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

// ★ 追加：チャットコンテキスト & メタバッジ
import { useIrosChat } from './IrosChatContext';
import IrosMetaBadge from './components/IrosMetaBadge';

export type HeaderProps = {
  onShowSideBar?: () => void;
  onCreateNewChat?: () => void;
  onRefresh?: () => void;
  icon?: React.ReactNode;
  meta?: any;
};

export default function IrosHeader({
  onShowSideBar,
  onCreateNewChat,
  onRefresh,
  icon,
  meta,
}: HeaderProps) {
  const router = useRouter();
  const title = 'Mu';

  const openMuBook = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    router.push('/books');
  };

  const chatCtx = (typeof useIrosChat === 'function' ? useIrosChat() : null) as any;

  const currentMeta =
    meta ??
    chatCtx?.currentMeta ??
    chatCtx?.lastMeta ??
    chatCtx?.meta ??
    null;

    const qCodeRaw =
    currentMeta?.qCode ??
    currentMeta?.q_code ??
    currentMeta?.q ??
    currentMeta?.extra?.ctxPack?.qCode ??
    currentMeta?.unified?.q?.current ??
    null;

    const qCode: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | undefined =
    typeof qCodeRaw === 'string' && /^Q[1-5]$/i.test(qCodeRaw)
      ? (qCodeRaw.toUpperCase() as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5')
      : undefined;

  const normalizeDepthBand = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const band = value.trim().toUpperCase().slice(0, 1);
    return /^[SRCITF]$/.test(band) ? band : null;
  };

  const personDepthPatternRaw =
    currentMeta?.personDepthPattern ??
    currentMeta?.person_depth_pattern ??
    currentMeta?.qCounts?.person_depth_pattern ??
    currentMeta?.q_counts?.person_depth_pattern ??
    currentMeta?.extra?.personDepthPattern ??
    currentMeta?.extra?.person_depth_pattern ??
    currentMeta?.extra?.ctxPack?.personDepthPattern ??
    currentMeta?.extra?.ctxPack?.person_depth_pattern ??
    currentMeta?.extra?.memoryStateSnapshot?.personDepthPattern ??
    currentMeta?.extra?.memoryStateSnapshot?.person_depth_pattern ??
    currentMeta?.extra?.memoryStateSnapshot?.qCounts?.person_depth_pattern ??
    null;

  const depthTrendRaw =
    currentMeta?.depth_trend ??
    currentMeta?.depthTrend ??
    currentMeta?.extra?.depth_trend ??
    currentMeta?.extra?.depthTrend ??
    currentMeta?.extra?.memoryStateSnapshot?.depth_trend ??
    currentMeta?.extra?.memoryStateSnapshot?.depthTrend ??
    currentMeta?.extra?.ctxPack?.memoryStateSnapshot?.depth_trend ??
    currentMeta?.extra?.ctxPack?.memoryStateSnapshot?.depthTrend ??
    null;

  const longDepthRaw =
    depthTrendRaw?.long_depth_stage_candidate ??
    depthTrendRaw?.longDepthStageCandidate ??
    depthTrendRaw?.active_depth_band ??
    depthTrendRaw?.activeDepthBand ??
    null;

  const depthRaw =
    longDepthRaw ??
    personDepthPatternRaw ??
    currentMeta?.observedStage ??
    currentMeta?.depth ??
    currentMeta?.depthStage ??
    currentMeta?.depth_stage ??
    currentMeta?.extra?.ctxPack?.observedStage ??
    currentMeta?.extra?.ctxPack?.depthStage ??
    currentMeta?.unified?.depth?.current ??
    null;

  const depth = normalizeDepthBand(depthRaw);

  const mode = currentMeta?.mode ?? null;

  const defaultIcon = (
    <Image
      src="/mu001_s.png"
      alt="Iros"
      width={28}
      height={28}
      className="sof-icon-img"
      priority
      style={{
        objectFit: 'cover',
        borderRadius: '50%',
      }}
    />
  );

  const handleRefresh = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (onRefresh) onRefresh();
    else if (typeof window !== 'undefined') window.location.reload();
  };

  const handleMenu = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    onShowSideBar?.();
  };

  const handleNewChat = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('iros_chat_draft');
      }
    } catch {}

    if (onCreateNewChat) {
      onCreateNewChat();
    } else {
      router.replace('/?cid=new&agent=iros', { scroll: false });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('iros:new-chat'));
      }
    }
  };

  return (
    <header className="sof-header" role="banner" aria-label="AI header">
      <div className="sof-left">
        {onShowSideBar && (
          <button
            type="button"
            onClick={handleMenu}
            className="sof-btn"
            aria-label="メニューを開く"
            title="メニュー"
          >
            ☰
          </button>
        )}
      </div>

      <div className="sof-center">
        <span className="sof-icon-wrap">{icon ?? defaultIcon}</span>
        <span className="sof-title">{title}</span>
      </div>

      <div className="sof-right">
      <div className="sof-meta-wrap" aria-label="Iros meta indicator">
  <IrosMetaBadge qCode={qCode} depth={depth} mode={mode} compact />
</div>
        <button
          type="button"
          onClick={openMuBook}
          className="sof-btn"
          aria-label="Mu Book本棚を開く"
          title="Mu Book本棚"
        >
          📖 Book
        </button>


        <button
          type="button"
          onClick={handleNewChat}
          className="sof-btn sof-btn-accent"
          aria-label="新規チャット"
          title="新規"
        >
          ＋
        </button>
      </div>

      <style jsx>{`
.sof-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 42px;
  min-height: 42px;
  padding: 4px 8px;
  margin: 0;
  border-bottom: 1px solid #e6e6ee;
  background: #ffffff;
  position: sticky;
  top: 0;
  z-index: 10;
}
        .sof-left,
        .sof-right {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .sof-left {
          justify-content: flex-start;
        }
        .sof-right {
          justify-content: flex-end;
        }
        .sof-center {
          min-width: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          pointer-events: none;
        }
        .sof-icon-wrap {
          display: inline-flex;
          width: 28px;
          height: 28px;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          overflow: hidden;
          flex: 0 0 auto;
        }
        .sof-title {
          font-weight: 700;
          font-size: 16px;
          letter-spacing: 0.01em;
          color: #111827;
          white-space: nowrap;
        }
        .sof-btn {
          appearance: none;
          border: 1px solid #e5e7eb;
          background: #fff;
          color: #111827;
          border-radius: 999px;
          height: 30px;
          min-width: 30px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
          cursor: pointer;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }
        .sof-btn:hover {
          background: #f9fafb;
        }
        .sof-btn-accent {
          border-color: #111827;
          background: #111827;
          color: #fff;
          font-weight: 700;
        }
        .sof-btn-accent:hover {
          background: #1f2937;
        }
        .sof-meta-wrap {
          display: inline-flex;
          align-items: center;
        }
        @media (max-width: 480px) {
          .sof-header {
            height: 40px;
            min-height: 40px;
            padding: 4px 6px;
            gap: 4px;
          }
          .sof-title {
            font-size: 15px;
          }
          .sof-btn {
            height: 28px;
            min-width: 28px;
            padding: 0 8px;
            font-size: 12px;
          }
          .sof-right {
            gap: 4px;
          }
        }
      `}</style>
    </header>
  );
}
