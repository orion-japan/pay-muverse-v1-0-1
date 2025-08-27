'use client';

import { useEffect, useRef } from 'react';

type Star = {
  x: number; y: number; r: number; vx: number; vy: number;
  tw: number; twSpd: number; hue: number;
};
type Meteor = { x: number; y: number; vx: number; vy: number; life: number; hue: number; };

export default function Starfield() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const visRef = useRef<boolean>(true);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: true })!;
    let width = 0, height = 0, dpr = 1;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      const resize = () => {
        dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        width = Math.max(1, Math.floor(rect.width));
        height = Math.max(1, Math.floor(rect.height));
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (let i = 0; i < Math.floor((width * height) / 9000); i++) {
          const x = Math.random() * width;
          const y = Math.random() * height;
          const r = Math.random() * 0.9 + 0.3;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      resize();
      return () => ro.disconnect();
    }

    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let lastT = performance.now();

    const pickHueFromCSS = () => {
      const cs = getComputedStyle(document.documentElement);
      const h = parseFloat(cs.getPropertyValue('--bg-h') || '220');
      return isFinite(h) ? h : 220;
    };

    const spawn = () => {
      stars = [];
      const area = width * height;
      const baseCount = Math.min(450, Math.max(80, Math.floor(area / 6000)));
      const hueBase = pickHueFromCSS();

      for (let i = 0; i < baseCount; i++) {
        const r = Math.random() * 1.3 + 0.3;
        const speed = (Math.random() * 0.05 + 0.02);
        const dir = Math.random() * Math.PI * 2;
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r,
          vx: Math.cos(dir) * speed,
          vy: Math.sin(dir) * speed,
          tw: Math.random() * Math.PI * 2,
          twSpd: 0.003 + Math.random() * 0.004,
          hue: hueBase + (Math.random() * 20 - 10),
        });
      }
    };

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      spawn();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = (t: number) => {
      const dt = Math.min(40, t - lastT);
      lastT = t;

      ctx.clearRect(0, 0, width, height);

      ctx.globalCompositeOperation = 'lighter';
      for (const s of stars) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.tw += s.twSpd * dt;

        if (s.x < -2) s.x = width + 2;
        if (s.x > width + 2) s.x = -2;
        if (s.y < -2) s.y = height + 2;
        if (s.y > height + 2) s.y = -2;

        const twinkle = 0.6 + 0.4 * Math.sin(s.tw);
        const alpha = 0.6 * twinkle;

        ctx.fillStyle = `hsla(${s.hue.toFixed(1)} 90% 88% / ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3);
        grd.addColorStop(0, `hsla(${s.hue.toFixed(1)} 90% 88% / ${0.12 * twinkle})`);
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fill();
      }

      if (Math.random() < 0.0025) {
        const angle = (-Math.PI / 3) + (Math.random() * Math.PI / 6);
        const speed = 0.6 + Math.random() * 0.8;
        const x = Math.random() * width;
        const y = -20;
        meteors.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          hue: pickHueFromCSS() + 20,
        });
      }

      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx * dt * 1.2;
        m.y += m.vy * dt * 1.2;
        m.life -= 0.006 * dt;
        if (m.life <= 0 || m.x < -50 || m.x > width + 50 || m.y > height + 50) {
          meteors.splice(i, 1);
          continue;
        }
        const trail = 120;
        const nx = m.x - m.vx * trail;
        const ny = m.y - m.vy * trail;

        const grad = ctx.createLinearGradient(m.x, m.y, nx, ny);
        grad.addColorStop(0, `hsla(${m.hue.toFixed(1)} 100% 90% / ${0.8 * m.life})`);
        grad.addColorStop(1, `hsla(${m.hue.toFixed(1)} 100% 60% / 0)`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
      }
    };

    const loop = (t: number) => {
      if (visRef.current) draw(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const onVis = () => { visRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="starfield-canvas" aria-hidden />;
}
