'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAuth } from 'firebase/auth';
import './ShipButton.css';

type ShipLevel = 'S' | 'F' | 'R' | 'C' | 'I';

const LEVELS: { key: ShipLevel; label: string; hint: string; dot: string }[] = [
  { key: 'S', label: 'S｜気になる', hint: 'さりげない見守り', dot: '🟢' },
  { key: 'F', label: 'F｜つながる', hint: 'ゆるいつながり', dot: '🔵' },
  { key: 'R', label: 'R｜リスペクト', hint: '敬意・尊重', dot: '🟣' },
  { key: 'C', label: 'C｜共感', hint: '価値観に深く共感', dot: '🟠' },
  { key: 'I', label: 'I｜共鳴', hint: 'ほぼ一体として響き合う', dot: '🔴' },
];

type FetchResp = {
  isFollowing?: boolean;
  level?: ShipLevel | null;
  partnerLevel?: ShipLevel | null;
  mutual?: boolean;
  talkEnabled?: boolean;
};

type ShipButtonProps = {
  selfUserCode: string;
  targetUserCode: string;
  planStatus?: 'free' | 'regular' | 'premium' | 'master' | 'admin';
  onOpenTalk?: () => void;
};

export default function ShipButton({
  selfUserCode,
  targetUserCode,
  planStatus = 'free',
  onOpenTalk,
}: ShipButtonProps) {
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<ShipLevel | null>(null);
  const [partnerLevel, setPartnerLevel] = useState<ShipLevel | null>(null);
  const [mutual, setMutual] = useState(false);
  const [talkEnabled, setTalkEnabled] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isSelf = selfUserCode && targetUserCode && selfUserCode === targetUserCode;

  // free は S のみ、それ以外は全解放
  const lockedLevels = useMemo<ShipLevel[]>(() => {
    if (planStatus === 'free') {
      return ['F', 'R', 'C', 'I'];
    }
    return [];
  }, [planStatus]);

  // F Talk 解禁条件：課金ユーザーかつ F 以上
  const canTalk = useMemo(() => {
    if (planStatus === 'free') return false;
    return level !== null && ['F', 'R', 'C', 'I'].includes(level);
  }, [planStatus, level]);

  // Firebase トークン取得
  const getToken = async () => {
    const auth = getAuth();
    const user = auth.currentUser;
    if (!user) return null;
    return user.getIdToken(true);
  };

  // 初期読み込み（check-follow API）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!selfUserCode || !targetUserCode || isSelf) {
          setLoading(false);
          return;
        }
        const token = await getToken();
        const url = `/api/check-follow?target=${encodeURIComponent(
          targetUserCode,
        )}&me=${encodeURIComponent(selfUserCode)}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
        const data: FetchResp = await res.json();

        const myLevel: ShipLevel | null =
          (data.level as ShipLevel | null) ?? (data.isFollowing ? 'F' : null);

        if (!mounted) return;
        setLevel(myLevel);
        setPartnerLevel((data.partnerLevel as ShipLevel | null) ?? null);
        setMutual(Boolean(data.mutual));
        setTalkEnabled(Boolean(data.talkEnabled ?? (myLevel && myLevel >= 'F')));
      } catch (e: any) {
        setErrorMsg(e?.message ?? '読み込みに失敗しました');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [selfUserCode, targetUserCode, isSelf]);

  // ランク選択
  const handleSelect = async (newLevel: ShipLevel) => {
    if (isSubmitting) return;
    if (lockedLevels.includes(newLevel)) {
      setErrorMsg('このランクは現在のプランでは選択できません（アップグレードで解放）');
      return;
    }
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      const prev = level;
      setLevel(newLevel);

      const token = await getToken();
      const res = await fetch('/api/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          from_user_code: selfUserCode,
          to_user_code: targetUserCode,
          ship_type: newLevel,
        }),
      });

      if (!res.ok) {
        setLevel(prev);
        const msg = await res.text().catch(() => '');
        throw new Error(`POST /api/follow failed: ${res.status}${msg ? ` ${msg}` : ''}`);
      }

      const data: FetchResp = await res.json().catch(() => ({}));
      setMutual(Boolean(data.mutual));
      setPartnerLevel((data.partnerLevel as ShipLevel | null) ?? partnerLevel);
      setTalkEnabled(Boolean(data.talkEnabled ?? newLevel >= 'F'));
    } catch (e: any) {
      setErrorMsg(e?.message ?? '設定に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 解除
  const handleClear = async () => {
    if (isSubmitting) return;
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      const prev = level;
      setLevel(null);

      const token = await getToken();
      const res = await fetch('/api/unfollow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          from_user_code: selfUserCode,
          to_user_code: targetUserCode,
        }),
      });

      if (!res.ok) {
        setLevel(prev);
        const msg = await res.text().catch(() => '');
        throw new Error(`POST /api/unfollow failed: ${res.status}${msg ? ` ${msg}` : ''}`);
      }

      setMutual(false);
      setTalkEnabled(false);
      setPartnerLevel(null);
    } catch (e: any) {
      setErrorMsg(e?.message ?? '解除に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSelf) {
    return (
      <div className="ship-wrap">
        <button className="ship-btn disabled" disabled>
          自分のページ
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="ship-wrap">
        <div className="ship-skeleton" />
      </div>
    );
  }

  const current = LEVELS.find((l) => l.key === level) || null;
  const partner = LEVELS.find((l) => l.key === partnerLevel) || null;

  return (
    <div className="ship-wrap">
      <div className="ship-status">
        <div className="ship-row">
          <span className="ship-tag">あなた → 相手</span>
          <span className={`ship-badge ${current ? `lv-${current.key}` : 'lv-none'}`}>
            {current ? `${current.dot} ${current.label}` : '未設定'}
          </span>
        </div>
        <div className="ship-row">
          <span className="ship-tag">相手 → あなた</span>
          <span className={`ship-badge ${partner ? `lv-${partner.key}` : 'lv-none'}`}>
            {partner ? `${partner.dot} ${partner.label}` : '未設定'}
          </span>
        </div>
        <div className="ship-row">
          <span className="ship-tag">関係</span>
          <span className={`ship-badge ${mutual ? 'mutual' : 'asym'}`}>
            {mutual ? '相互（非対称の可能性あり）' : '非対称'}
          </span>
        </div>
        <div className="ship-row">
          <span className={`talk-indicator ${canTalk ? 'on' : 'off'}`}>
            {canTalk ? 'F Talk（共鳴体）開始可能' : 'F Talk未解放'}
          </span>
        </div>
      </div>

      <div className="ship-picker">
        {LEVELS.map((item) => {
          const active = level === item.key;
          const locked = lockedLevels.includes(item.key);
          return (
            <button
              key={item.key}
              className={`ship-choice ${active ? 'active' : ''} ${locked ? 'locked' : ''}`}
              title={item.hint}
              disabled={isSubmitting || locked}
              onClick={() => handleSelect(item.key)}
            >
              <span className="dot">{item.dot}</span>
              <span className="label">{item.label}</span>
              {locked && <span className="lock">🔒</span>}
            </button>
          );
        })}
      </div>

      <div className="ship-actions">
        <button
          className="ship-btn clear"
          disabled={isSubmitting || level === null}
          onClick={handleClear}
        >
          シップ解除
        </button>
        <button
          className={`ship-btn talk ${canTalk ? '' : 'disabled'}`}
          disabled={!canTalk || isSubmitting}
          onClick={() => onOpenTalk?.()}
        >
          F Talk を開く
        </button>
      </div>

      {errorMsg && <div className="ship-error">{errorMsg}</div>}

      {planStatus === 'free' && (
        <div className="ship-plan-note">課金すると F 以上（F Talk）が解放されます。</div>
      )}
    </div>
  );
}
