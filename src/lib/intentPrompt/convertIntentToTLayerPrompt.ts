// src/lib/intentPrompt/convertIntentToTLayerPrompt.ts
// 🪞 意図フォームを Qコード + T層 に変換し、
// 文字や人物、風景を含まない純粋なエネルギー構造プロンプトを生成します。

import type { IntentionForm } from '@/lib/intentPrompt/schema'; // ← 修正ポイント！
import type { FineTuneInput } from '@/lib/intentPrompt/schema';

/* ========== メイン関数 ========== */
export function convertIntentToTLayerPrompt(
  form: IntentionForm,
  ft?: Partial<FineTuneInput>
): string {
  const q = detectQCode(form.mood);
  const t = form.tLayer;
  const field = buildResonanceField(q, t, ft);
  return field.prompt;
}

/* ========== Q→T変換から場構造を構築 ========== */
function buildResonanceField(
  q: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5',
  t: 'T1' | 'T2' | 'T3' | 'T4' | 'T5',
  ft?: Partial<FineTuneInput>
) {
  const qDef = Q_DEF[q];
  const tDef = T_DEF[t];

  const baseTone = ft?.baseTone ?? tDef.color;
  const lightness = ft?.baseLPercent ?? tDef.luminance;
  const texture = ft?.texture ?? qDef.texture;
  const motif = ft?.flowMotif ?? qDef.flow;
  const turbulence = ft?.obstaclePattern ?? qDef.distortion;

  const prompt = `
An abstract ${baseTone} field representing the ${tDef.name} layer.
Wave structure: ${qDef.wave}, flowing with ${motif}.
Tone: ${qDef.tone}, Texture: ${texture}, Turbulence: ${turbulence}.
Light direction: ${qDef.light}, Resonance motion: ${tDef.motion}.
No faces, no text, no landscapes, no symbolic objects.
Expressing ${qDef.emotion} through ${tDef.vibration}.
Soft-grain luminous field, energy density ${tDef.density}, lightness ${lightness}%.
`;

  return { prompt };
}

/* ========== Q層定義（Emotion Vector） ========== */
const Q_DEF = {
  Q1: {
    emotion: 'discipline and inner silence',
    wave: 'standing low-frequency wave',
    tone: 'metallic clarity',
    light: 'vertical ascent',
    flow: 'ordered oscillation',
    distortion: 'geometric ripples',
    texture: 'crystalline grain',
  },
  Q2: {
    emotion: 'growth and collective renewal',
    wave: 'ascending spiral wave',
    tone: 'emerald resonance',
    light: 'upward expansion',
    flow: 'spiral uplift',
    distortion: 'branch turbulence',
    texture: 'fiber grain',
  },
  Q3: {
    emotion: 'stability through uncertainty',
    wave: 'horizontal interference wave',
    tone: 'amber tone',
    light: 'ground diffusion',
    flow: 'intersecting plains',
    distortion: 'static density',
    texture: 'matte granular',
  },
  Q4: {
    emotion: 'purification and memory flow',
    wave: 'oscillating liquid wave',
    tone: 'deep water tone',
    light: 'subtle downward shimmer',
    flow: 'wave memory drift',
    distortion: 'liquid distortion',
    texture: 'smooth reflective',
  },
  Q5: {
    emotion: 'radiant will and passion',
    wave: 'high-frequency emission wave',
    tone: 'crimson brilliance',
    light: 'outward radiance',
    flow: 'explosive bloom',
    distortion: 'heat shimmer',
    texture: 'glow mist',
  },
} as const;

/* ========== T層定義（Trans Layer Matrix） ========== */
const T_DEF = {
  T1: {
    name: 'Transcend Initiation',
    vibration: 'origin pulse',
    color: 'silver black',
    luminance: 5,
    motion: 'birth oscillation',
    density: 'point singularity',
  },
  T2: {
    name: 'Transdimensional Flow',
    vibration: 'dual resonance',
    color: 'deep ultramarine',
    luminance: 16,
    motion: 'cross-current flow',
    density: 'rippled field',
  },
  T3: {
    name: 'Truth Embodiment',
    vibration: 'golden core resonance',
    color: 'white gold',
    luminance: 35,
    motion: 'fusion rotation',
    density: 'spiral core',
  },
  T4: {
    name: 'Temporal Reflection',
    vibration: 'time-layer echo',
    color: 'amber green',
    luminance: 28,
    motion: 'mirrored slow wave',
    density: 'layered transparency',
  },
  T5: {
    name: 'Total Resonance',
    vibration: 'omnidirectional pulse',
    color: 'prismatic white',
    luminance: 40,
    motion: 'spherical expansion',
    density: 'field unification',
  },
} as const;

/* ========== mood → Q判定 ========== */
function detectQCode(mood: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' {
  if (mood.includes('静')) return 'Q1';
  if (mood.includes('希')) return 'Q2';
  if (mood.includes('不安')) return 'Q3';
  if (mood.includes('感謝')) return 'Q4';
  if (mood.includes('情熱')) return 'Q5';
  return 'Q2';
}
