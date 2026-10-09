import type { Database, Tx } from './app.js';

export declare const DEFAULT_MIGRATIONS_DIR: string;
export declare function createPgDatabase(connectionString: string, options?: { max?: number }): Database;
export declare function withUser<R>(db: Database, userId: string, fn: (tx: Tx) => Promise<R>): Promise<R>;
export declare function migrate(db: Database, migrationsDir?: string): Promise<string[]>;
