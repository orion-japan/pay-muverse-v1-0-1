// src/components/SofiaChat/MetaPanel.tsx
'use client';
import React from 'react';
import './MetaPanel.css';

type UsedKnowledge = { id: string; key: string; title: string | null };

/**
 * 既存の構造は維持しつつ、Irosの軽量メタ（conversationId / qcode / layer / scores など）に両対応。
 * - 旧: conversation_id / currentQ / depthStage / stochastic{...}
 * - 新: conversationId / qcode / layer / scores / g / seed / noiseAmp / epsilon / __system_used
 */
export type MetaData = {
  // --- 既存 ---
  qcodes?: { code: string; score?: number }[];
  layers?: { layer: string; score?: number }[];
  used_knowledge?: UsedKnowledge[];

  stochastic?:
    | boolean
    | {
        epsilon?: number;
        noiseAmp?: number;
        seed?: number;
        on?: boolean;
        g?: number | null;
        retrNoise?: number | null;
        retrSeed?: number | null;
      };

  // 既存：top-levelでも来ることがある
  g?: number;
  seed?: number;
  noiseAmp?: number;

  // 検索用補助（任意）
  stochastic_params?: {
    epsilon?: number | null;
    retrNoise?: number | null;
    retrSeed?: number | null;
  };

  // --- 既存(Iros想定の軽量メタ・旧名) ---
  conversation_id?: string | null;
  phase?: string;
  currentQ?: string;
  depthStage?: string;
  self_acceptance?: number;

  // --- 新(Iros route)で追加されうるキー ---
  conversationId?: string;
  qcode?: string;
  layer?: string;
  scores?: Record<string, number>;
  epsilon?: number;
  __system_used?: string;
  credit?: number | null;
};

export function MetaPanel({ meta }: { meta: MetaData | null | undefined }) {
  if (!meta) return null;

  // Qコードの表示整形
  const showQ = (code: string | number) => {
    const s = String(code ?? '').trim();
    return /^q/i.test(s) ? s.toUpperCase() : `Q${s}`;
  };

  // ===== インジケータの統合ビュー =====
  const stRaw = meta.stochastic;

  const ind = {
    on:
      typeof stRaw === 'boolean'
        ? stRaw
        : typeof stRaw === 'object' && stRaw
          ? !!stRaw.on
          : undefined,
    g:
      typeof meta.g === 'number'
        ? meta.g
        : typeof stRaw === 'object' && stRaw && typeof stRaw.g === 'number'
          ? stRaw.g
          : undefined,
    seed:
      typeof meta.seed === 'number'
        ? meta.seed
        : typeof stRaw === 'object' && stRaw && typeof stRaw.seed === 'number'
          ? stRaw.seed
          : undefined,
    noiseAmp:
      typeof meta.noiseAmp === 'number'
        ? meta.noiseAmp
        : typeof stRaw === 'object' && stRaw && typeof stRaw.noiseAmp === 'number'
          ? stRaw.noiseAmp
          : undefined,
    epsilon:
      typeof meta.epsilon === 'number'
        ? meta.epsilon
        : typeof stRaw === 'object' && stRaw && typeof stRaw.epsilon === 'number'
          ? stRaw.epsilon
          : typeof meta.stochastic_params?.epsilon === 'number'
            ? meta.stochastic_params?.epsilon
            : undefined,
    retrNoise:
      typeof stRaw === 'object' && stRaw && typeof stRaw.retrNoise === 'number'
        ? stRaw.retrNoise
        : typeof meta.stochastic_params?.retrNoise === 'number'
          ? meta.stochastic_params?.retrNoise
          : undefined,
    retrSeed:
      typeof stRaw === 'object' && stRaw && typeof stRaw.retrSeed === 'number'
        ? stRaw.retrSeed
        : typeof meta.stochastic_params?.retrSeed === 'number'
          ? meta.stochastic_params?.retrSeed
          : undefined,
  };

  const hasAnyIndicator =
    typeof stRaw === 'boolean' ||
    (typeof stRaw === 'object' && stRaw) ||
    typeof meta.g === 'number' ||
    typeof meta.seed === 'number' ||
    typeof meta.noiseAmp === 'number' ||
    typeof meta.epsilon === 'number' ||
    (meta.stochastic_params &&
      (meta.stochastic_params.epsilon != null ||
        meta.stochastic_params.retrNoise != null ||
        meta.stochastic_params.retrSeed != null));

  // Iros互換メタの存在判定（旧名・新名どちらでも）
  const convId = meta.conversationId ?? meta.conversation_id ?? null;
  const irosPhase = meta.phase ?? null;
  const irosQ = meta.qcode ?? meta.currentQ ?? null;
  const irosDepth = meta.layer ?? meta.depthStage ?? null;
  const saPct =
    typeof meta.self_acceptance === 'number' ? Math.round(meta.self_acceptance * 100) : null;

  const hasIrosMeta =
    convId != null ||
    irosPhase != null ||
    irosQ != null ||
    irosDepth != null ||
    saPct != null ||
    meta.scores != null ||
    meta.credit != null ||
    meta.__system_used != null;

  return (
    <div className="meta-panel">
      <h4 className="meta-title">
        <span className="dot" />
        Resonance Meta
      </h4>

      {/* Iros系の軽量メタ（存在する場合のみ） */}
      {hasIrosMeta ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot" />
            <span>Intent Meta</span>
            <span className="badge">位相 / Q / 深度</span>
          </div>
          <div className="meta-kv">
            {irosPhase ? (
              <div>
                phase: <b>{irosPhase}</b>
              </div>
            ) : null}
            {irosQ ? (
              <div>
                Q: <b>{showQ(irosQ)}</b>
              </div>
            ) : null}
            {irosDepth ? (
              <div>
                depth: <b>{irosDepth}</b>
              </div>
            ) : null}
            {saPct != null ? (
              <div>
                self-acceptance: <b>{saPct}%</b>
              </div>
            ) : null}
            {meta.credit != null ? (
              <div>
                credit: <b>{meta.credit}</b>
              </div>
            ) : null}
            {meta.__system_used ? (
              <div>
                system: <code>{meta.__system_used}</code>
              </div>
            ) : null}
            {convId ? (
              <div className="meta-id">
                conv: <code>{convId}</code>
              </div>
            ) : null}
          </div>

          {/* scores（新Irosが返す場合のみ） */}
          {meta.scores && typeof meta.scores === 'object' ? (
            <ul className="meta-list">
              {Object.entries(meta.scores).map(([k, v]) => (
                <li className="meta-item" key={k}>
                  <span className="meta-chip">{k}</span>
                  <span className="meta-score">({String(v)})</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Qコード（既存配列） */}
      {meta.qcodes?.length ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot" />
            <span>Q Codes</span>
            <span className="badge">共鳴タグ</span>
          </div>
          <ul className="meta-list">
            {meta.qcodes.map((q, i) => (
              <li className="meta-item" key={i}>
                <span className="meta-chip">{showQ(q.code)}</span>
                {q.score != null && <span className="meta-score">({q.score})</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 層（既存配列 / 旧I/T層） */}
      {meta.layers?.length ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot gold" />
            <span>Layers</span>
            <span className="badge">I/T 層</span>
          </div>
          <ul className="meta-list">
            {meta.layers.map((l, i) => (
              <li className="meta-item" key={i}>
                <span className="meta-chip gold">{l.layer}</span>
                {l.score != null && <span className="meta-score">({l.score})</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 参照ナレッジ */}
      {meta.used_knowledge?.length ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot blue" />
            <span>Knowledge</span>
            <span className="badge">参照</span>
          </div>
          <ul className="meta-list">
            {meta.used_knowledge.map((k) => (
              <li className="meta-item" key={k.id}>
                <span className="meta-chip blue">{k.key}</span>
                <span>{k.title || 'Untitled'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 確率的パラメータ（新旧両対応） */}
      {hasAnyIndicator ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot" />
            <span>Stochastic</span>
            <span className="badge">探索率</span>
          </div>

          <div className="meta-kv">
            {ind.on !== undefined && (
              <div>
                mode: <b>{ind.on ? 'ON' : 'OFF'}</b>
              </div>
            )}
            {ind.g != null && (
              <div>
                g (explore): <b>{ind.g}</b>
              </div>
            )}
            {ind.noiseAmp != null && (
              <div>
                noiseAmp: <b>{ind.noiseAmp}</b>
              </div>
            )}
            {ind.seed != null && (
              <div>
                seed: <b>{ind.seed}</b>
              </div>
            )}
            {ind.epsilon != null && (
              <div>
                ε (explore): <b>{ind.epsilon}</b>
              </div>
            )}
            {ind.retrNoise != null && (
              <div>
                retrievalNoise: <b>{ind.retrNoise}</b>
              </div>
            )}
            {ind.retrSeed != null && (
              <div>
                retrievalSeed: <b>{ind.retrSeed}</b>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
