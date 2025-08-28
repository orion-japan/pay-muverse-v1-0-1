// src/hooks/useBgHue.ts
import { useEffect } from 'react';

export default function useBgHue() {
  useEffect(() => {
    let hue = 260; // 初期値（CSSと同じ）
    const duration = 24 * 60 * 60 * 1000; // 24時間で1周（ミリ秒）
    const step = 360 / (duration / 1000); // 1秒ごとの増加量

    const interval = setInterval(() => {
      hue = (hue + step) % 360;
      document.documentElement.style.setProperty('--bg-h', hue.toFixed(2));
    }, 1000); // 1秒ごとに更新

    return () => clearInterval(interval);
  }, []);
}
