// scripts/test-intention-prompt.ts
import generatePrompt from '@/lib/intentPrompt/generatePrompt';
import type { IntentionForm } from '@/lib/intentPrompt/schema';

const form: IntentionForm = {
  name: 'テストユーザー',
  target: '世界の子どもたち',
  desire: '教育の機会が広がってほしい',
  reason: '生まれた環境で未来が決まってしまうことへの違和感',
  vision: 'どこにいても、自分の可能性を信じられる世界',
  mood: '希望',
  visibility: '公開',
  lat: undefined,
  lon: undefined,
  season: '未指定',
  timing: '近未来',
  tLayer: 'T2',
};

const yaml = generatePrompt(form, {
  baseTone: 'deep ultramarine',
  baseLPercent: 16,
  texture: 'soft grain',
  flowMotif: 'gentle arcs',
  obstaclePattern: 'turbulence',
});

console.log(yaml);
