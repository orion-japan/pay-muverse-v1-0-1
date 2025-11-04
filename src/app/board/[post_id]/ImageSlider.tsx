'use client';

import { useRef } from 'react';

export default function ImageSlider({ urls }: { urls: string[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const slideBy = (dir: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    el.scrollBy({ left: dir * w, behavior: 'smooth' });
  };

  if (urls.length <= 1) {
    return (
      <img
        src={urls[0]}
        alt="image-0"
        style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 10 }}
      />
    );
  }

  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <div className="slider-wrap" ref={wrapRef}>
        {urls.map((src, i) => (
          <div className="slide" key={i}>
            <img src={src} alt={`image-${i}`} loading="lazy" />
          </div>
        ))}
      </div>

      {/* prev/next */}
      <button className="nav prev" onClick={() => slideBy(-1)} aria-label="前へ">
        ‹
      </button>
      <button className="nav next" onClick={() => slideBy(1)} aria-label="次へ">
        ›
      </button>
    </div>
  );
}
