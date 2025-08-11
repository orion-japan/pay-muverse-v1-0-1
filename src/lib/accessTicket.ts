import crypto from 'crypto'

/**
 * 指定した user_code に基づき、署名付きURLクエリを生成
 * @param user_code - ユーザーコード（例: "669933"）
 * @param secret - 共有シークレット（MU_SHARED_ACCESS_SECRET）
 * @param ttlSec - 有効期限秒（デフォ15分）
 */
export function generateSignedQuery(user_code: string, secret: string, ttlSec: number = 15 * 60) {
  const ts = Math.floor(Date.now() / 1000) // 現在秒
  const base = `ts=${ts}&user_code=${user_code}`
  const sig = crypto.createHmac('sha256', secret).update(base).digest('hex')
  return { ts, sig }
}
