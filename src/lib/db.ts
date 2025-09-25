// シンプルな Postgres 接続（DATABASE_URL 使用）
// 例: postgres://user:pass@host:5432/dbname
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  // ローカル/開発で落とさないために warn のみに
  console.warn('[db] DATABASE_URL not set. Logger will no-op.');
}

export const db = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
});
