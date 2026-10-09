import type { Express, Response } from 'express';

/** Adaptateur de base : requêtes simples et transactions (pg en production, PGlite dans les tests). */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface Logger {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

export interface AppOptions {
  db?: Database | null;
  verifyToken?: ((token: string) => Promise<string>) | null;
  authUrl?: string;
  distDir?: string;
  logger?: Logger;
}

export declare const DEFAULT_DIST: string;
export declare function sendDatabaseError(res: Response, error: unknown, logger?: Logger): Response;
export declare function createApp(options?: AppOptions): Express;
