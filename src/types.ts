export type Surface = "admin" | "proxy";

export type AccountState =
  | "ok"
  | "cooldown"
  | "quota_exhausted"
  | "expired"
  | "unknown"
  | "revoked"
  | "dead";

export type Strategy = "fallback" | "best-quota" | "load-balance" | "weighted";

export interface Env {
  POOL: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ROTATION_JOURNAL: R2Bucket;
  MASTER_KEY: string;
  ENVIRONMENT: string;
  ADMIN_HOST: string;
  PROXY_HOST: string;
  ADMIN_AUTH_MODE: "access" | "dev";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  UPSTREAM_BASE: string;
  OAUTH_ISSUER: string;
  OAUTH_CLIENT_ID: string;
  MAX_REQUEST_BODY_BYTES: string;
}

export interface AccountRecord {
  id: string;
  label: string;
  accountId: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  idTokenCiphertext: string;
  state: AccountState;
  enabled: boolean;
  credentialVersion: number;
  lastRefreshedAt: string;
  cooldownUntil: string;
  nextProbeAt: string;
  concurrencyCap: number;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedAccount extends AccountRecord {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface CandidateAccount extends AccountRecord {
  position: number;
  weight: number;
  headroom: number;
}

export interface PolicyGroupRecord {
  id: string;
  name: string;
  strategy: Strategy;
}

export interface EndpointResolution {
  endpoint: string;
  group: PolicyGroupRecord;
  accounts: CandidateAccount[];
}

export interface AuthImportTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  idToken: string;
}

export interface SelectedApiKey {
  id: string;
  label: string;
  endpoints: string[];
  ipAllowlist: string[];
}

export interface RotationJournalEntry {
  accountId: string;
  baseVersion: number;
  targetVersion: number;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  idTokenCiphertext: string;
  createdAt: string;
}
