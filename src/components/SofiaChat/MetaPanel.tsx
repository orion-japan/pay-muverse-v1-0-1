'use client';
import React from "react";
import "./MetaPanel.css";

type UsedKnowledge = { id: string; key: string; title: string | null };

export type MetaData = {
  qcodes?: { code: string; score?: number }[];
  layers?: { layer: string; score?: number }[];
  used_knowledge?: UsedKnowledge[];
  // ▼ 互換: 旧(オブジェクト) / 新(真偽値) / 新(詳細オブジェクト) のいずれも受け付ける
  stochastic?:
    | boolean
    | {
        // 旧フィールド（retrieve系）
        epsilon?: number;
        noiseAmp?: number;
        seed?: number;
        // 新フィールド（表示系）
        on?: boolean;
        g?: number | null;
        retrNoise?: number | null;
        retrSeed?: number | null;
      };
  // ※ サーバ側が top-level に g/seed/noiseAmp を返すケースもあるため、任意で受ける
  g?: number;
  seed?: number;
  noiseAmp?: number;
  // 検索側の補助（任意）
  stochastic_params?: {
    epsilon?: number | null;
    retrNoise?: number | null;
    retrSeed?: number | null;
  };
};

export function MetaPanel({ meta }: { meta: MetaData | null | undefined }) {
  if (!meta) return null;

  // Qコードの表示: 既に "Q1" 形式ならそのまま、数値や "1" なら "Q1" に整形
  const showQ = (code: string | number) => {
    const s = String(code ?? '').trim();
    return /^q/i.test(s) ? s : `Q${s}`;
  };

  // ===== インジケータの統合ビュー =====
  // 旧: meta.stochastic = { epsilon, noiseAmp, seed }
  // 新A: meta.stochastic = boolean（ON/OFF）
  // 新B: meta に top-level の g/seed/noiseAmp、または meta.stochastic.{on,g,seed,noiseAmp}
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
      typeof stRaw === 'object' && stRaw && typeof stRaw.epsilon === 'number'
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
    (meta.stochastic_params && (meta.stochastic_params.epsilon != null ||
                                meta.stochastic_params.retrNoise != null ||
                                meta.stochastic_params.retrSeed != null));

  return (
    <div className="meta-panel">
      <h4 className="meta-title">
        <span className="dot" />
        Resonance Meta
      </h4>

      {/* Qコード */}
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

      {/* I層/T層 */}
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
                <span>{k.title || "Untitled"}</span>
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
            {/* 新: ON/OFF（stochastic が boolean または .on） */}
            {ind.on !== undefined && (
              <div>mode: <b>{ind.on ? 'ON' : 'OFF'}</b></div>
            )}

            {/* 新: g (explore) */}
            {ind.g != null && (
              <div>g (explore): <b>{ind.g}</b></div>
            )}

            {/* 共通: noiseAmp / seed */}
            {ind.noiseAmp != null && (
              <div>noiseAmp: <b>{ind.noiseAmp}</b></div>
            )}
            {ind.seed != null && (
              <div>seed: <b>{ind.seed}</b></div>
            )}

            {/* 旧: ε（探索度パラメータ） */}
            {ind.epsilon != null && (
              <div>ε (explore): <b>{ind.epsilon}</b></div>
            )}

            {/* 参考情報（検索側のノイズやシード。無ければ非表示） */}
            {ind.retrNoise != null && (
              <div>retrievalNoise: <b>{ind.retrNoise}</b></div>
            )}
            {ind.retrSeed != null && (
              <div>retrievalSeed: <b>{ind.retrSeed}</b></div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
