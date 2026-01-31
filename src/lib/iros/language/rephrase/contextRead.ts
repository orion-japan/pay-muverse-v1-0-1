// iros — context readers (read-only, side-effect free)

export type AnyCtx = any;

/**
 * flowDigest を安全に取得する（参照のみ）
 * 優先順：
 *  - ctx.flowDigest
 *  - ctx.meta.flowDigest
 *  - ctx.extra.flowDigest
 *  - ctx.orch.flowDigest
 */
export function readFlowDigest(ctx: AnyCtx | null): string | null {
  if (!ctx) return null;
  const v =
    ctx.flowDigest ??
    ctx?.meta?.flowDigest ??
    ctx?.extra?.flowDigest ??
    ctx?.orch?.flowDigest ??
    null;

  const s = String(v ?? '').trim();
  return s || null;
}
export const readFlowTape = (ctx: any | null): string | null => {
  const v =
    ctx?.flowTape ??
    ctx?.meta?.flowTape ??
    ctx?.extra?.flowTape ??
    ctx?.orch?.flowTape ??
    null;
  const s = String(v ?? '').trim();
  return s || null;
};
