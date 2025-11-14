'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import styles from './slideshow.module.css';

export default function SlideshowPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);

  // 👉 切り替わり間隔（秒）
  const [speed, setSpeed] = useState(10);

  // A / B の 2 レイヤー
  const [imgA, setImgA] = useState<string | null>(null);
  const [imgB, setImgB] = useState<string | null>(null);

  // 表示側（レンダー用）
  const [showA, setShowA] = useState(true);

  // ロジック用 ref（setInterval 内で使う）
  const showARef = useRef(true);
  const idxRef = useRef(0);
  const imagesRef = useRef<string[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  /* -----------------------------
     画像取得
  ----------------------------- */
  const loadImages = async () => {
    const { data } = await supabase.storage
      .from('private-posts')
      .list('669933/', { limit: 200 });

    const urls: string[] = [];

    for (const f of data ?? []) {
      if (!f.name.match(/\.(jpg|jpeg|png|webp)$/i)) continue;

      const { data: signed } = await supabase.storage
        .from('private-posts')
        .createSignedUrl(`669933/${f.name}`, 3600);

      if (signed?.signedUrl) urls.push(signed.signedUrl);
    }

    setImages(urls);
    imagesRef.current = urls;
    setLoading(false);
  };

  /* -----------------------------
     完全安定クロスフェード
  ----------------------------- */
  const doCrossFade = () => {
    const list = imagesRef.current;
    if (list.length < 2) return;

    const currentShowA = showARef.current;
    const nextIdx = (idxRef.current + 1) % list.length;
    const nextImg = list[nextIdx];

    if (currentShowA) {
      // 今 A が前 → B に次の画像をセット
      setImgB(nextImg);
    } else {
      // 今 B が前 → A に次の画像をセット
      setImgA(nextImg);
    }

    // 次のフレームでレイヤーを入れ替え（ここでクロス）
    requestAnimationFrame(() => {
      const newShowA = !currentShowA;
      showARef.current = newShowA;
      setShowA(newShowA);
      idxRef.current = nextIdx;
    });
  };

  /* -----------------------------
     スライド開始
  ----------------------------- */
  const startLoop = () => {
    const list = imagesRef.current;
    if (list.length < 2) return;

    idxRef.current = 0;
    showARef.current = true;
    setShowA(true);

    setImgA(list[0]);
    setImgB(list[1]);

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(doCrossFade, speed * 1000);
  };

  /* -----------------------------
     初回ロード
  ----------------------------- */
  useEffect(() => {
    const run = async () => {
      await loadImages();
    };
    run();

    // アンマウント時にタイマー停止
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /* -----------------------------
     フルスクリーン
  ----------------------------- */
  const enterFull = async () => {
    const el = document.getElementById('slideshow-wrapper');
    if (el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
      } catch {
        // 失敗しても無視
      }
    }
  };

  const handleStart = async () => {
    await enterFull();
    setStarted(true);
    startLoop();
  };

  /* -----------------------------
     ESC / フルスクリーン終了 → 停止
  ----------------------------- */
  useEffect(() => {
    const stopSlideshow = () => {
      setStarted(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const onFsChange = () => {
      if (!document.fullscreenElement) {
        stopSlideshow();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        stopSlideshow();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
      }
    };

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  /* -----------------------------
     UI 出し分け
  ----------------------------- */
  if (loading)
    return <div className={styles.loading}>Loading...</div>;

  if (!started) {
    return (
      <div style={{ maxWidth: 400, margin: '40px auto', textAlign: 'center' }}>
        <h2>スライドショー設定</h2>

        <label>速度（秒）</label>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          style={{ width: '100%', padding: 10 }}
        >
          <option value={6}>6秒</option>
          <option value={8}>8秒</option>
          <option value={10}>10秒</option>
          <option value={12}>12秒</option>
          <option value={15}>15秒</option>
        </select>

        <button
          onClick={handleStart}
          style={{ marginTop: 20, padding: '12px 0', width: '100%' }}
        >
          スライドショー開始
        </button>
      </div>
    );
  }

  /* -----------------------------
     スライドショー本体
  ----------------------------- */
  return (
    <div id="slideshow-wrapper" className={styles.wrapper}>
      {imgA && (
        <img
          src={imgA}
          className={`${styles.layer} ${showA ? styles.show : styles.hide}`}
        />
      )}
      {imgB && (
        <img
          src={imgB}
          className={`${styles.layer} ${!showA ? styles.show : styles.hide}`}
        />
      )}
    </div>
  );
}
