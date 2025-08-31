'use client';
import React from "react";
import "./MetaPanel.css";

type UsedKnowledge = { id: string; key: string; title: string | null };

export type MetaData = {
  qcodes?: { code: string; score?: number }[];
  layers?: { layer: string; score?: number }[];
  used_knowledge?: UsedKnowledge[];
  stochastic?: { epsilon: number; noiseAmp: number; seed: number };
};

export function MetaPanel({ meta }: { meta: MetaData | null | undefined }) {
  if (!meta) return null;

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
                <span className="meta-chip">{`Q${q.code}`}</span>
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

      {/* 確率的パラメータ */}
      {meta.stochastic ? (
        <div className="meta-block">
          <div className="meta-label">
            <span className="k-dot" />
            <span>Stochastic</span>
            <span className="badge">探索率</span>
          </div>
          <div className="meta-kv">
            <div>ε (explore): <b>{meta.stochastic.epsilon}</b></div>
            <div>noiseAmp: <b>{meta.stochastic.noiseAmp}</b></div>
            <div>seed: <b>{meta.stochastic.seed}</b></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
