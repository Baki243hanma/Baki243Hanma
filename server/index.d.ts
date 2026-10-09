export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  authUrl: string;
  migrateOnStart: boolean;
}
export declare function readConfig(env?: Record<string, string | undefined>): ServerConfig;
