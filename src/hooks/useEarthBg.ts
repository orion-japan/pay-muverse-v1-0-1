'use client';

import { useEffect } from 'react';

type Opts = {
  /** 何秒で1サイクル（昼→夜→昼）するか。既定120秒 */
  cycleSeconds?: number;
  /** 色相の変化をなめらかに補間するか */
  smooth?: boolean;
  /** 昼の星の濃さ（0〜1） */
  starsDayAlpha?: number;
  /** 夜の星の濃さ（0〜1） */
  starsNightAlpha?: number;
};

/**
 * ページ背景（超パステル）を時間でゆっくり変化させる。
 * CSS変数を更新:
 *   --bg-h, --bg-top, --bg-bottom, --bg-top-soft, --bg-bottom-soft, --stars-alpha
 */
export default function useEarthBg(opts: Opts = {}) {
  const {
    cycleSeconds = 120,
    smooth = true,
    starsDayAlpha = 0.06,
    starsNightAlpha = 0.12,
  } = opts;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;

    let raf: number | null = null;
    let lastHue: number | null = null;

    const tick = () => {
      // 0..1 の周期 t を生成（任意秒で一周）
      const nowSec = performance.now() / 1000;
      const t = (nowSec % cycleSeconds) / cycleSeconds;

      // -1..1 のサイクル波
      const cyc = Math.sin(2 * Math.PI * t);

      // ほぼ白の中で、ほんの少しだけ色相が往復（220±40）
      const hueRaw = 220 + 40 * cyc;
      const hue = smooth && lastHue != null ? lastHue + (hueRaw - lastHue) * 0.12 : hueRaw;
      lastHue = hue;

      // ほぼ白の明度（上層/下層）。±3〜4%だけゆらぐ
      const l1 = 99 - 3 * Math.cos(2 * Math.PI * (t - 0.10)); // 96〜102相当（実際はhslの範囲で丸め）
      const l2 = 98 - 4 * Math.cos(2 * Math.PI * (t + 0.15)); // 94〜102相当

      // CSS変数に反映（非常に薄いパステル）
      const top = `hsl(${hue.toFixed(1)} 18% ${Math.min(100, Math.max(0, l1)).toFixed(1)}%)`;
      const bottom = `hsl(${(hue + 20).toFixed(1)} 20% ${Math.min(100, Math.max(0, l2)).toFixed(1)}%)`;
      const topSoft = `hsla(${hue.toFixed(1)} 18% ${Math.min(100, Math.max(0, l1 + 1)).toFixed(1)}% / 0.20)`;
      const bottomSoft = `hsla(${(hue + 20).toFixed(1)} 20% ${Math.min(100, Math.max(0, l2 + 1)).toFixed(1)}% / 0.20)`;

      root.style.setProperty('--bg-h', hue.toFixed(1));
      root.style.setProperty('--bg-top', top);
      root.style.setProperty('--bg-bottom', bottom);
      root.style.setProperty('--bg-top-soft', topSoft);
      root.style.setProperty('--bg-bottom-soft', bottomSoft);

      // 昼→夜で星の濃さをわずかに増やす（昼0, 夜1）
      const night01 = Math.max(0, -cyc); // サイン波の下側だけ
      const alpha = starsDayAlpha + (starsNightAlpha - starsDayAlpha) * night01;
      root.style.setProperty('--stars-alpha', alpha.toFixed(3));

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cycleSeconds, smooth, starsDayAlpha, starsNightAlpha]);
}
