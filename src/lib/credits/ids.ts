// src/lib/credits/ids.ts
export function makeIdempotencyKey(userId: string, ref: string) {
  return `u:${userId}|ref:${ref}`;
}
