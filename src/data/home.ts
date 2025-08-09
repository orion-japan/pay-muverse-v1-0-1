import type { HomeContent } from '@/lib/content';

export const homeContent: HomeContent = {
  heroImages: ['/hero_mu.png'], // 1枚でも配列でOK。増やすなら ['/mu_24.png','/mu_14.png']
  notices: [
    { id: 'n1', text: '共鳴会の開催 — 小さな気づきや成長を仲間と分かち合う場' },
    { id: 'n2', text: 'Muの問いで日々の心を整える' },
  ],
};
