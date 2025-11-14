// src/lib/intentPrompt/generatePrompt.ts
// 意図 → 抽象フィールド構造 → 画像プロンプト生成
// 推測しない・非具象・key:value 構造一貫化

import type { IntentionForm, FineTuneInput } from './schema';
import { classifyIntention, type QCode } from './classifier';

/* ============================================================
   Qコード（Emotion Flow → Elemental Abstract Expression）
   ============================================================ */

type QProfile = {
  label: string;
  element: string; // 抽象的な比喩（火・水などではなく “性質” ）
  motion: string; // 動きの方向性
  density: string; // 密度傾向
  color_base: string; // 基本色
  inner_color: string; // インナー層
  outer_color: string; // アウター層
};

const Q_PROFILE: Record<QCode, QProfile> = {
  Q1: {
    label: '内的静寂（Metal）',
    element: 'stillness-field (non-moving quiet vibration)',
    motion: 'subtle micro-oscillation, near-static',
    density: 'fine, low-density grain with smooth uniformity',
    color_base: 'cool silver-blue mist',
    inner_color: 'deep bluish-silver, low chroma, calm',
    outer_color: 'very soft pale silver haze',
  },
  Q2: {
    label: '成長と再生（Wood）',
    element: 'growth-field (wind-like, expanding)',
    motion: 'softly rising currents, multi-direction flow',
    density: 'regions of dense motion alternating with airy spaces',
    color_base: 'teal + ultramarine + young-leaf-green blend',
    inner_color: 'deeper teal-green with higher saturation',
    outer_color: 'light yellow-green mist, soft diffusion',
  },
  Q3: {
    label: '安定と重心（土）',
    element: 'stability-field (gravity-like layers)',
    motion: 'slow horizontal drifts, plate-like strata',
    density: 'medium-heavy density with gentle compression zones',
    color_base: 'warm amber + earth-brown diffuse blend',
    inner_color: 'deep amber-brown, slightly denser grain',
    outer_color: 'light sandy-amber mist',
  },
  Q4: {
    label: '浄化と記憶（水）',
    element: 'purification-field (diffusing, cleansing)',
    motion: 'slow oscillating waves, large-scale diffusion',
    density: 'light-medium density with soft fading zones',
    color_base: 'deep aqueous blue + blue-grey mix',
    inner_color: 'deeper aqueous blue with clarity',
    outer_color: 'soft pale blue-grey vapor',
  },
  Q5: {
    label: '情熱と放射（Fire）',
    element: 'radiance-field (non-literal luminous activity)',
    motion: 'soft radiant drift (no rays, no bursts)',
    density: 'high micro-grain luminance clusters',
    color_base: 'crimson-glow + warm gold diffusion',
    inner_color: 'deep warm red-gold microclusters',
    outer_color: 'soft warm-gold mist',
  },
};

/* ============================================================
   T層プリセット
   ============================================================ */

type TLayer = IntentionForm['tLayer'];

const TLAYER: Record<
  TLayer,
  {
    label: string;
    archetype: string; // フィールド構造の型
    baseL: number;
    grain: string;
    voidNote: string;
  }
> = {
  T1: {
    label: 'Transcend Initiation（静けさの起点）',
    archetype: 'cloud-field (mist-like minimal flow)',
    baseL: 14,
    grain: 'ultra-fine sparse',
    voidNote: 'tiny void points (5–10%)',
  },
  T2: {
    label: 'Transdimensional Flow（関係の流れ）',
    archetype: 'ambient-flow-field (multi-direction drift)',
    baseL: 16,
    grain: 'small grains clustering softly',
    voidNote: 'faint dark membranes woven across field',
  },
  T3: {
    label: 'Truth Embodiment（真姿の顕れ）',
    archetype: 'radiant-layered-field (in-out balance)',
    baseL: 18,
    grain: 'small–medium mixed grains',
    voidNote: 'tiny luminous void-cores',
  },
  T4: {
    label: 'Field Unification（場の統合）',
    archetype: 'breathing-field (whole-plane coherence)',
    baseL: 20,
    grain: 'fine cohesive alignment',
    voidNote: 'soft veiled edges',
  },
  T5: {
    label: 'Void–Radiance Cycle（空無と光の循環）',
    archetype: 'rare-current-field (emergent-disappearing)',
    baseL: 17,
    grain: 'micro star-like clusters',
    voidNote: 'deep pockets dispersed lightly',
  },
};

/* ============================================================
   数値レンジのガード
   ============================================================ */

function clampBaseL(v: number): number {
  return Math.max(12, Math.min(22, Math.round(v)));
}

/* ============================================================
   Target emphasis（人物名や場所名は使わず、傾向だけ）
   ============================================================ */
function targetEmphasis(t: string | undefined): string {
  const tx = t ?? '';
  if (/家族/.test(tx)) return 'warm cohesion zones (family-like intimacy)';
  if (/世界/.test(tx)) return 'wide evenly-distributed harmony zones';
  if (/場|場所|神社|寺|park|forest|mountain|beach/i.test(tx))
    return 'subtle vertical luminance tilts (non-scenic)';
  return 'neutral balanced field';
}

/* ============================================================
   安全系（禁止領域）
   ============================================================ */

const SAFETY = `
forbidden: [faces, people, bodies, hands, eyes, animals, objects, buildings, trees, scenery, text, letters, logos, icons, symbols, mandalas, sigils, horizon, center-focus, radial-light, single-vanish-point, strong-spirals, hard-branches]
permitted: [light, tone, color, grain, field movement, luminance gradients]
exposure: "HDR-safe, highlight clip ≤ 90%"
`.trim();

/* ============================================================
   Main
   ============================================================ */

export function generateIntentionPrompt(
  form: IntentionForm,
  ft?: FineTuneInput,
): string {
  // ------------ 0. フォーム内容から Q/T を推定 -------------
  const combinedText = [
    form.target,
    form.desire,
    form.reason,
    form.vision,
  ]
    .filter(Boolean)
    .join('\n');

  const cls = classifyIntention({
    mood: form.mood,
    text: combinedText,
  });

  const q = cls.qCode;
  const qp = Q_PROFILE[q];

  const tKey = cls.tCode as TLayer;
  const t = TLAYER[tKey];

  // Q 分布（色ミックス用）
  const qDist = cls.qDistribution;
  const qDistLine = (Object.keys(qDist) as QCode[])
    .map((k) => `${k}=${qDist[k].toFixed(2)}`)
    .join(', ');

  // アクセント用パレット（代表Q以外でそこそこ強いもの）
  const accentPalettes: string[] = [];
  for (const k of Object.keys(Q_PROFILE) as QCode[]) {
    if (k === q) continue;
    const w = qDist[k];
    if (w > 0.15) {
      accentPalettes.push(`${k}: ${Q_PROFILE[k].color_base}`);
    }
  }
  const accentPalette =
    accentPalettes.length > 0 ? accentPalettes.join(' ; ') : 'none (single-Q dominant)';

  const phaseStr = cls.phase === 'inner' ? 'IN' : 'OUT';

  const baseTone = ft?.baseTone ?? 'deep ultramarine';
  const baseL = clampBaseL(ft?.baseLPercent ?? t.baseL);
  const texture = ft?.texture ?? 'soft grain';
  const flowMotif = ft?.flowMotif ?? 'ambient-drift';
  const obstacle = ft?.obstaclePattern ?? 'turbulence';

  const lines: string[] = [];

  /* --------------------------
     TOP META
  --------------------------- */
  lines.push('format: abstract-intention-field');
  lines.push(SAFETY);
  lines.push('');

  /* --------------------------
     INTENTION
  --------------------------- */
  lines.push('intention:');
  lines.push(`  q_code: ${q}`);
  lines.push(`  q_label: "${qp.label}"`);
  lines.push(`  phase: ${phaseStr}`);
  lines.push(`  t_layer: ${tKey}`);
  lines.push(`  t_label: "${t.label}"`);
  lines.push(`  confidence: ${cls.confidence.toFixed(2)}`);
  lines.push('');

  /* --------------------------
     ELEMENTAL EXPRESSION
  --------------------------- */
  lines.push('elemental_expression:');
  lines.push(`  element_analogy: "${qp.element}"`);
  lines.push(`  motion: "${qp.motion}"`);
  lines.push(`  density_pattern: "${qp.density}"`);
  lines.push('');

  /* --------------------------
     Q COLOR (INNER / OUTER + DISTRIBUTION)
  --------------------------- */
  lines.push('q_color:');
  lines.push(`  dominant_q: ${q}`);
  lines.push(`  distribution: "${qDistLine}"`);
  lines.push(`  base_palette: "${qp.color_base}"`);
  lines.push(`  inner_layer: "${qp.inner_color}"`);
  lines.push(`  outer_layer: "${qp.outer_color}"`);
  lines.push(
    '  mixing_rule: "INNER/OUTER patches distributed across field; no single center; smooth transitions"',
  );
  lines.push(`  accent_palette: "${accentPalette}"`);
  lines.push('');

  /* --------------------------
     FIELD ARCHETYPE
  --------------------------- */
  lines.push('field_archetype:');
  lines.push(`  type: "${t.archetype}"`);
  lines.push(`  grain_pattern: "${t.grain}"`);
  lines.push(`  void_pattern: "${t.voidNote}"`);
  lines.push('');

  /* --------------------------
     BASE FIELD
  --------------------------- */
  lines.push('base_field:');
  lines.push('  composition: "boundaryless, non-centered, multi-orientation drift"');
  lines.push(
    '  edge_fill: "field continues fully to edges; no large empty border; background stays within same palette, never plain solid"',
  );
  lines.push(`  brightness: "base lightness around L${baseL}%"`);
  lines.push(`  color_base: "${baseTone}"`);
  lines.push(`  texture: "${texture}"`);
  lines.push('');

  /* --------------------------
     FLOW + FINE TUNE
  --------------------------- */
  lines.push('fine_tune:');
  lines.push(`  flow_motif: "${flowMotif}"`);
  lines.push(`  obstacle_pattern: "${obstacle}"`);
  lines.push('  sheet_glow: "distributed small glows, no central light source"');
  lines.push('');

  /* --------------------------
     EMPHASIS
  --------------------------- */
  lines.push('field_emphasis:');
  lines.push(`  description: "${targetEmphasis(form.target)}"`);
  lines.push('');

  /* --------------------------
     DK REFERENCE
  --------------------------- */
  lines.push('dk_reference:');
  lines.push('  style: "Hasegawa-Akira-inspired luminance field"');
  lines.push('  light_behavior: "distributed glows, no center, light extends beyond frame"');
  lines.push('  edge_behavior: "soft dissolving edges"');

  return lines.join('\n');
}

/* 既存互換用 default */
export default function generatePrompt(form: IntentionForm, ft: FineTuneInput) {
  return generateIntentionPrompt(form, ft);
}
