'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/* ---------------------------------------------------------
   1) 型定義（フォーム & 微調整）
--------------------------------------------------------- */
export type Mood = '静けさ' | '希望' | '情熱' | '不安' | '迷い' | '感謝';
export type Visibility = '公開' | '非公開';
export type TLayer = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface IntentionForm {
  name: string;
  target: string;
  desire: string;
  reason: string;
  vision: string;
  mood: Mood;
  visibility: Visibility;
  season: string;
  timing: string;
  tLayer: TLayer;
  lat?: number;
  lon?: number;
}

export interface FineTuneInput {
  baseTone: string;
  baseLPercent: number;
  texture: string;
  highlightClipPercent: number;
  flowMotif: string;
  obstaclePattern: string;
  addNotes: string[];
}

/* ---------------------------------------------------------
   2) T層自動判定
--------------------------------------------------------- */
function inferTLayer(mood: Mood): TLayer {
  switch (mood) {
    case '静けさ': return 'T1';
    case '希望':   return 'T2';
    case '情熱':   return 'T3';
    case '不安':    return 'T4';
    case '迷い':
    case '感謝':
    default:        return 'T5';
  }
}

/* ---------------------------------------------------------
   3) T層 → baseTone 自動変換
--------------------------------------------------------- */
function toneFromTLayer(t: TLayer): string {
  switch (t) {
    case 'T1': return 'soft pearl';
    case 'T2': return 'sky lavender';
    case 'T3': return 'coral flame';
    case 'T4': return 'midnight teal';
    case 'T5': return 'prism light';
    default:   return 'soft pearl';
  }
}

/* ---------------------------------------------------------
   4) Base Prompt（Sofia前段階）
--------------------------------------------------------- */
function generateBasePrompt(form: IntentionForm, ft: FineTuneInput): string {
  return `
User intention summary:
- name: ${form.name}
- target: ${form.target}
- desire: ${form.desire}
- reason: ${form.reason}
- vision: ${form.vision}
- mood: ${form.mood}
- tLayer: ${form.tLayer}

Image tone settings:
- baseTone: ${ft.baseTone}
- lightness: ${ft.baseLPercent}
- texture: ${ft.texture}
- flow: ${ft.flowMotif}
- turbulence: ${ft.obstaclePattern}

Please convert this into a universal abstract-resonance prompt.
  `.trim();
}

/* ---------------------------------------------------------
   5) メインフック useIntentionPrompt
--------------------------------------------------------- */
export function useIntentionPrompt() {
  const router = useRouter();
  const searchParams = useSearchParams();

  /* ------------------ form state ------------------ */
  const [form, setForm] = useState<IntentionForm>({
    name: '',
    target: '',
    desire: '',
    reason: '',
    vision: '',
    mood: '希望',
    visibility: '公開',
    season: '未指定',
    timing: '設けない',
    tLayer: 'T2',
  });

  /* ------------------ fine-tune state ------------------ */
  const [ft, setFt] = useState<FineTuneInput>({
    baseTone: 'sky lavender',  // 初期値 → T2 と一致
    baseLPercent: 16,
    texture: 'soft grain',
    highlightClipPercent: 90,
    flowMotif: 'converging streams',
    obstaclePattern: 'turbulence',
    addNotes: [],
  });

  const [basePrompt, setBasePrompt] = useState('');
  const [sofiaPrompt, setSofiaPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');

  /* ---------------------------------------------------------
     mood → tLayer → baseTone 自動反映
  --------------------------------------------------------- */
  const updateForm = <K extends keyof IntentionForm>(key: K, value: IntentionForm[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };

      if (key === 'mood') {
        next.tLayer = inferTLayer(value as Mood);

        // ⭐ T層に合わせて baseTone を自動更新
        const tone = toneFromTLayer(next.tLayer);
        setFt((prevFt) => ({ ...prevFt, baseTone: tone }));
      }

      return next;
    });
  };

  const updateFt = <K extends keyof FineTuneInput>(key: K, value: FineTuneInput[K]) =>
    setFt((prev) => ({ ...prev, [key]: value }));

  /* ---------------------------------------------------------
     Base Prompt（前段解析）
  --------------------------------------------------------- */
  const regenerateBasePrompt = () => {
    try {
      const text = generateBasePrompt(form, ft);
      setBasePrompt(text);
      setRuntimeError('');
      return text;
    } catch (e: any) {
      setRuntimeError(e.message);
      return '';
    }
  };

  /* ---------------------------------------------------------
     Sofia解析（本番プロンプト）
  --------------------------------------------------------- */
  const runSofia = async () => {
    try {
      setLoading(true);
      setRuntimeError('');

      const analysis = basePrompt || regenerateBasePrompt();

      const res = await fetch('/api/intent/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analysis }),
      });

      const json = await res.json();
      if (!json?.ok) throw new Error('Sofia解析に失敗しました');

      setSofiaPrompt(json.result.prompt);
      return json.result.prompt;
    } catch (e: any) {
      setRuntimeError(e.message);
      return '';
    } finally {
      setLoading(false);
    }
  };

  /* ---------------------------------------------------------
     画像生成（横長）
  --------------------------------------------------------- */
  const generateImage = async () => {
    try {
      setLoading(true);
      setRuntimeError('');

      const prompt = sofiaPrompt || (await runSofia());

      const res = await fetch('/api/intent-image/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const json = await res.json();
      if (!json?.ok) throw new Error('画像生成に失敗しました');

      setImageUrl(json.url);
      return json.url;
    } catch (e: any) {
      setRuntimeError(e.message);
      return '';
    } finally {
      setLoading(false);
    }
  };

  /* ---------------------------------------------------------
     ギャラリー保存
  --------------------------------------------------------- */
  const saveToGallery = async () => {
    try {
      setLoading(true);
      setRuntimeError('');

      if (!imageUrl) throw new Error('画像がありません');

      const res = await fetch('/api/intention-gallery/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `${form.name}-${form.tLayer}`,
          imageUrl,
          prompt: sofiaPrompt,
          form,
          finetune: ft,
        }),
      });

      const json = await res.json();
      if (!json?.ok) throw new Error('ギャラリー保存に失敗しました');

      return json.id;
    } catch (e: any) {
      setRuntimeError(e.message);
      return '';
    } finally {
      setLoading(false);
    }
  };

  return {
    form,
    ft,
    updateForm,
    updateFt,
    basePrompt,
    sofiaPrompt,
    imageUrl,
    loading,
    runtimeError,
    regenerateBasePrompt,
    runSofia,
    generateImage,
    saveToGallery,
  };
}
