import type { Express } from 'express';

export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export declare function createApp(): Express;
export declare function publicConfig(): PublicConfig;
