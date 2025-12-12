// src/lib/qcode/save.ts
import type { QRes } from './types';
import type { QCode, QStage, QLayer, QPolarity, QIntent } from './record';
import { writeQCodeWithSR } from './qcode-adapter';

/**
 * 旧: q_code_logs / q_code_timeline_store / user_q_now へ直INSERT
 * 新: ✅ qcode-adapter.writeQCodeWithSR()（統一入口）へ委譲
 */
export async function saveQRes(
  sbUrl: string,
  srKey: string,
  user_code: string,
  qres: QRes,
  source_type: string,
  intent: string = 'chat',
) {
  // QRes -> 抽出
  const q = (qres as any)?.currentQ as QCode | undefined;
  const stage = (qres as any)?.depthStage as QStage | undefined;
  const layer = (qres as any)?.layer as QLayer | undefined;
  const polarity = (qres as any)?.polarity as QPolarity | undefined;

  if (!q) throw new Error('[qcode/save] qres.currentQ missing');

  // intent 正規化（未知は normal）
  const intentSafe: QIntent = ([
    'normal',
    'chat',
    'consult',
    'diagnosis',
    'self_post',
    'event',
    'comment',
    'vision',
    'vision_check',
    'import',
    'system',
    'auto',
    'iros_chat',
  ] as const).includes(intent as any)
    ? (intent as QIntent)
    : 'normal';

  const stageSafe: QStage = stage === 'S2' || stage === 'S3' ? stage : 'S1';
  const layerSafe: QLayer = layer === 'outer' ? 'outer' : 'inner';
  const polaritySafe: QPolarity = polarity === 'ease' ? 'ease' : 'now';

  const sourceTypeSafe = String(source_type || 'unknown');
  const userCodeSafe = String(user_code);

  const created_at = new Date().toISOString();

  // ✅ 統一入口へ
  await writeQCodeWithSR(sbUrl, srKey, {
    user_code: userCodeSafe,
    source_type: sourceTypeSafe,
    intent: intentSafe,
    q,
    stage: stageSafe,
    layer: layerSafe,
    polarity: polaritySafe,
    created_at,
    extra: {
      _from: 'saveQRes',
      qres_raw: qres,
    },
  });

  return {
    ok: true as const,
    user_code: userCodeSafe,
    q,
    stage: stageSafe,
    layer: layerSafe,
    polarity: polaritySafe,
    intent: intentSafe,
    source_type: sourceTypeSafe,
    created_at,
  };
}
