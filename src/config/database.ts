
import 'dotenv/config';
import { Pool, PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error(
        'DATABASE_URL is required. Check your .env file.'
    );
}

export const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: true }
        : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

export async function withClient<T>(
    callback: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await pool.connect();

    try {
        return await callback(client);
    } finally {
        client.release();
    }
}
import { QueryResultRow } from 'pg';

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await pool.query<T>(sql, params)).rows;
}
