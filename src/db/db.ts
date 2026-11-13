import 'dotenv/config';
import path from 'path';

// DATABASE_URL이 있으면 실제 PostgreSQL(배포), 없으면 로컬 파일 PostgreSQL(PGlite)을 쓴다.
type Row = Record<string, any>;
type Runner = { query: (sql: string, params?: any[]) => Promise<Row[]>; exec: (sql: string) => Promise<void> };

let runner: Promise<Runner> | null = null;

async function makeRunner(): Promise<Runner> {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    // 같은 DB를 다른 과제와 함께 쓰므로 미소치과 테이블은 별도 스키마(DB_SCHEMA, 기본 miso)에만 둔다
    const schema = (process.env.DB_SCHEMA || 'miso').replace(/[^a-z0-9_]/gi, '');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false }, options: `-c search_path=${schema},public` });
    await pool.query(`create schema if not exists ${schema}`);
    return {
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      exec: async (sql) => { await pool.query(sql); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', '..', 'data', 'pglite');
  (await import('fs')).mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir, { extensions: { btree_gist } });
  return {
    query: async (sql, params) => (await db.query<Row>(sql, params)).rows,
    exec: async (sql) => { await db.exec(sql); },
  };
}

export function getDb(): Promise<Runner> {
  if (!runner) runner = makeRunner();
  return runner;
}

export async function q<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  return (await getDb()).query(sql, params) as Promise<T[]>;
}
