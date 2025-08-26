'use client';

import { useEffect, useState } from 'react';

type Props = {
  visionId: string;
  title: string;
  resultStatus: '成功' | '中断' | '意図違い';
  phase: 'initial' | 'mid' | 'final';
  resultedAt: string;
  userCode: string;
  onChanged?: () => void;
};

const DAYS = { initial: 7, mid: 14, final: 21 };

export default function VisionResultCard({
  visionId, title, resultStatus, phase, resultedAt, userCode, onChanged
}: Props) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const limit = DAYS[phase] ?? 7;
    const ended = new Date(resultedAt).getTime();
    const diff = limit * 24 * 60 * 60 * 1000 - (Date.now() - ended);
    setRemaining(Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24))));
  }, [phase, resultedAt]);

  const callApi = async (url: string, body: any) => {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
      body: JSON.stringify(body),
    });
    onChanged?.();
  };

  const handleResume = () => callApi('/api/visions/result', { vision_id: visionId, result_status: null });
  const handleArchive = () => callApi('/api/visions/archive', { vision_id: visionId });

  return (
    <div className={`result-card status-${resultStatus}`}>
      <h3>{title}</h3>
      <div className="badge">{resultStatus}</div>

      {remaining !== null && (
        <div className="remaining">
          {remaining > 0
            ? <>残り {remaining} 日で自動で履歴へ移ります</>
            : <>自動移管対象です</>}
        </div>
      )}

      <div className="actions">
        <button onClick={handleResume}>再開する</button>
        <button onClick={handleArchive}>履歴に送る</button>
      </div>
    </div>
  );
}
