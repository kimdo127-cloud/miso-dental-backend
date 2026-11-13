import 'dotenv/config';
import path from 'path';

// DATABASE_URL이 있으면 실제 PostgreSQL(배포), 없으면 로컬 파일 PostgreSQL(PGlite)을 쓴다.
type Row = Record<string, any>;
type Runner = { query: (sql: string, params?: any[]) => Promise<Row[]>; exec: (sql: string) => Promise<void> };

let runner: Promise<Runner> | null = null;

async function makeRunner(): Promise<Runner> {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false } });
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
