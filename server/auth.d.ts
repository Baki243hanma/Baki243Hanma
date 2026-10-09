export declare class AuthConfigError extends Error {}
export declare function authOrigin(authUrl: string): string;
export declare function jwksUrl(authUrl: string): string;
export declare function createTokenVerifier(options: { authUrl: string; keySet?: unknown }): (token: string) => Promise<string>;
