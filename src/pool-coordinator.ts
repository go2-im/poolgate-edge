import { parseAuthJson } from "./auth-import";
import { decryptSecret, encryptSecret, importMasterKey, newApiKey, randomId, sha256Hex } from "./crypto";
import {
  isTerminalOAuthFailure,
  parseRotationJournal,
  persistCredentialRotation,
  rotationReconcileAction
} from "./credential-rotation";
import { bearerToken, discardRequestBody, endpointFromPath, json, jsonError } from "./http";
import { matchesIpAllowlist, normalizeIpAllowlist } from "./ip";
import { accountAvailability, hasCapacity, isEligible, selectAccount, type SelectionState } from "./policy";
import { currentSchemaVersion, migrateSchema } from "./schema";
import type {
  AccountRecord,
  CandidateAccount,
  DecryptedAccount,
  EndpointResolution,
  Env,
  RotationJournalEntry,
  SelectedApiKey,
  Strategy
} from "./types";
import {
  exhaustedReset,
  headroomFromStoredWindows,
  minimumHeadroom,
  parseStoredUsage,
  parseUsagePayload,
  type CurrentUsage
} from "./usage";
import { normalizeClose, webSocketMessageBytes } from "./websocket";

const DEFAULT_GROUP_ID = "group_default";
const DEFAULT_ENDPOINT = "default";
const MAX_ADMIN_BODY_BYTES = 1024 * 1024;
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const TURN_AFFINITY_TTL_MS = 10 * 60_000;
const TURN_AFFINITY_MAX = 4096;
const STRATEGIES = new Set<Strategy>(["fallback", "best-quota", "load-balance", "weighted"]);
const MAX_MEMBER_WEIGHT = 1_000_000;
const MAX_USAGE_BODY_BYTES = 1024 * 1024;
const MAX_PROBES_PER_ALARM = 3;
const HEALTHY_PROBE_INTERVAL_MS = 15 * 60_000;
const FAILED_PROBE_INTERVAL_MS = 5 * 60_000;
const EXPIRED_PROBE_INTERVAL_MS = 30 * 60_000;
const MIN_ALARM_DELAY_MS = 1_000;
const MAX_USAGE_RETRY_AFTER_MS = 24 * 60 * 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 20_000;

interface AccountRow {
  [key: string]: SqlStorageValue;
  id: string;
  label: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  id_token: string;
  state: AccountRecord["state"];
  enabled: number;
  credential_version: number;
  last_refreshed_at: string;
  cooldown_until: string;
  next_probe_at: string;
  concurrency_cap: number;
  created_at: string;
  updated_at: string;
  position: number;
  weight: number;
  windows: string;
}

interface ImportRequest {
  content?: unknown;
  authJson?: unknown;
  label?: unknown;
}

interface CreateApiKeyRequest {
  label?: unknown;
  endpoints?: unknown;
  expiresInDays?: unknown;
  ipAllowlist?: unknown;
}

interface UpdateApiKeyRequest {
  label?: unknown;
  endpoints?: unknown;
  expiresInDays?: unknown;
  ipAllowlist?: unknown;
}

interface UpdateAccountRequest {
  label?: unknown;
  concurrencyCap?: unknown;
  enabled?: unknown;
}

interface PolicyGroupRequest {
  name?: unknown;
  strategy?: unknown;
  memberAccountIds?: unknown;
  memberWeights?: unknown;
}

interface EndpointRequest {
  name?: unknown;
  groupId?: unknown;
}

interface OAuthResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  error?: unknown;
}

class OAuthRefreshFailure extends Error {
  readonly terminal: boolean;

  constructor(status: number, code: string) {
    super(`OAuth refresh failed with ${status}`);
    this.name = "OAuthRefreshFailure";
    this.terminal = isTerminalOAuthFailure(code);
  }
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    label: row.label,
    accountId: row.account_id,
    accessTokenCiphertext: row.access_token,
    refreshTokenCiphertext: row.refresh_token,
    idTokenCiphertext: row.id_token,
    state: row.state,
    enabled: Number(row.enabled) !== 0,
    credentialVersion: Number(row.credential_version),
    lastRefreshedAt: row.last_refreshed_at,
    cooldownUntil: row.cooldown_until,
    nextProbeAt: row.next_probe_at,
    concurrencyCap: Number(row.concurrency_cap),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function retryAfter(response: Response, maximum = 5 * 60_000): number {
  const raw = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maximum);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maximum);
  return 30_000;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class PoolCoordinator {
  private readonly sql: SqlStorage;
  private readonly selection: SelectionState = {
    inFlight: new Map(),
    roundRobin: new Map(),
    weightedCurrent: new Map()
  };
  private readonly refreshes = new Map<string, Promise<DecryptedAccount>>();
  private readonly masterKey: Promise<CryptoKey>;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.sql = state.storage.sql;
    state.storage.transactionSync(() => migrateSchema(this.sql));
    state.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT OR IGNORE INTO policy_groups (id, name, strategy) VALUES (?, ?, ?)",
        DEFAULT_GROUP_ID,
        "Default",
        "fallback"
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO endpoints (name, group_id) VALUES (?, ?)",
        DEFAULT_ENDPOINT,
        DEFAULT_GROUP_ID
      );
    });
    this.masterKey = importMasterKey(env.MASTER_KEY);
    state.blockConcurrencyWhile(async () => this.scheduleNextAlarm());
  }

  async fetch(request: Request): Promise<Response> {
    const surface = request.headers.get("x-poolgate-surface");
    const url = new URL(request.url);
    try {
      if (surface === "admin") return await this.handleAdmin(request, url);
      if (surface === "proxy") return await this.handleProxy(request, url);
      await discardRequestBody(request);
      return jsonError(400, "invalid_surface", "request was not routed through the Poolgate Edge worker");
    } catch (error) {
      await discardRequestBody(request);
      console.error("request failed", error);
      return jsonError(500, "internal_error", "the request could not be completed");
    }
  }

  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM turn_affinity WHERE expires_at <= ?", new Date().toISOString());
    });
    const now = new Date().toISOString();
    const due = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM accounts
          WHERE enabled = 1 AND state NOT IN ('revoked', 'dead')
            AND (next_probe_at = '' OR next_probe_at <= ?)
            AND (cooldown_until = '' OR cooldown_until <= ?)
          ORDER BY CASE WHEN next_probe_at = '' THEN 0 ELSE 1 END, next_probe_at ASC, id ASC
          LIMIT ?`,
        now,
        now,
        MAX_PROBES_PER_ALARM
      )
      .toArray();
    for (const account of due) {
      try {
        await this.pollAccountUsage(account.id);
      } catch (error) {
        console.warn("scheduled usage poll failed", account.id, error instanceof Error ? error.message : "unknown error");
        this.deferProbe(account.id);
      }
    }
    await this.scheduleNextAlarm();
  }

  private async handleAdmin(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && url.pathname === "/admin/api/status") {
      const accounts = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts").one();
      const endpoints = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM endpoints").one();
      const apiKeys = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM api_keys").one();
      return json({
        service: "poolgate-edge",
        schemaVersion: currentSchemaVersion(this.sql),
        accounts: Number(accounts.count),
        endpoints: Number(endpoints.count),
        apiKeys: Number(apiKeys.count)
      });
    }

    if (request.method === "GET" && url.pathname === "/admin/api/accounts") {
      const rows = this.sql
        .exec<AccountRow & { plan_type: string; usage_windows: string; usage_captured_at: string }>(
          `SELECT accounts.id, accounts.label, accounts.account_id, accounts.state, accounts.enabled,
                  accounts.credential_version, accounts.last_refreshed_at, accounts.cooldown_until,
                  accounts.next_probe_at, accounts.concurrency_cap, accounts.created_at, accounts.updated_at,
                  '' AS access_token, '' AS refresh_token, '' AS id_token,
                  COALESCE(usage_current.plan_type, '') AS plan_type,
                  COALESCE(usage_current.windows, '[]') AS usage_windows,
                  COALESCE(usage_current.captured_at, '') AS usage_captured_at
             FROM accounts
             LEFT JOIN usage_current ON usage_current.account_id = accounts.id
            ORDER BY accounts.created_at ASC`
        )
        .toArray();
      return json({
        accounts: rows.map((row) => ({
          ...this.safeAccount(rowToAccount(row)),
          usage: parseStoredUsage(row.usage_windows, row.plan_type, row.usage_captured_at)
        }))
      });
    }

    if (request.method === "POST" && url.pathname === "/admin/api/accounts/import") {
      return this.importAccount(request);
    }

    const accountMatch = /^\/admin\/api\/accounts\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && accountMatch) {
      return this.updateAccount(request, accountMatch[1]);
    }
    const accountProbeMatch = /^\/admin\/api\/accounts\/([A-Za-z0-9_]+)\/probe$/.exec(url.pathname);
    if (request.method === "POST" && accountProbeMatch) {
      const result = await this.pollAccountUsage(accountProbeMatch[1]);
      return result instanceof Response ? result : json({ usage: result });
    }
    if (request.method === "GET" && url.pathname === "/admin/api/policy-groups") {
      return this.listPolicyGroups();
    }
    if (request.method === "POST" && url.pathname === "/admin/api/policy-groups") {
      return this.createPolicyGroup(request);
    }
    const policyGroupMatch = /^\/admin\/api\/policy-groups\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && policyGroupMatch) {
      return this.updatePolicyGroup(request, policyGroupMatch[1]);
    }

    if (request.method === "GET" && url.pathname === "/admin/api/endpoints") {
      return this.listEndpoints();
    }
    if (request.method === "POST" && url.pathname === "/admin/api/endpoints") {
      return this.createEndpoint(request);
    }
    const endpointMatch = /^\/admin\/api\/endpoints\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && endpointMatch) {
      return this.updateEndpoint(request, endpointMatch[1]);
    }

    if (request.method === "GET" && url.pathname === "/admin/api/api-keys") {
      return this.listApiKeys();
    }

    if (request.method === "POST" && url.pathname === "/admin/api/api-keys") {
      return this.createApiKey(request);
    }

    const regenerateMatch = /^\/admin\/api\/api-keys\/([A-Za-z0-9_]+)\/regenerate$/.exec(url.pathname);
    if (request.method === "POST" && regenerateMatch) {
      return this.regenerateApiKey(request, regenerateMatch[1]);
    }

    const apiKeyMatch = /^\/admin\/api\/api-keys\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && apiKeyMatch) {
      return this.updateApiKey(request, apiKeyMatch[1]);
    }
    if (request.method === "DELETE" && apiKeyMatch) {
      return this.deleteApiKey(apiKeyMatch[1]);
    }

    return jsonError(404, "not_found", "admin API route not found");
  }

  private async importAccount(request: Request): Promise<Response> {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_ADMIN_BODY_BYTES) return jsonError(413, "body_too_large", "import body exceeds 1 MiB");

    let input: ImportRequest;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes)) as ImportRequest;
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }

    let tokens;
    try {
      tokens = parseAuthJson(text(input.content) || text(input.authJson));
    } catch (error) {
      return jsonError(400, "invalid_auth_file", error instanceof Error ? error.message : "invalid auth.json");
    }

    const key = await this.masterKey;
    const [accessToken, refreshToken, idToken] = await Promise.all([
      encryptSecret(key, tokens.accessToken),
      encryptSecret(key, tokens.refreshToken),
      encryptSecret(key, tokens.idToken)
    ]);
    const now = new Date().toISOString();
    const existing = this.sql
      .exec<{ id: string }>("SELECT id FROM accounts WHERE account_id = ?", tokens.accountId)
      .toArray()[0];
    const accountId = existing?.id ?? randomId("acct");
    this.state.storage.transactionSync(() => {
      if (existing) {
        this.sql.exec(
          `UPDATE accounts
              SET label = ?, access_token = ?, refresh_token = ?, id_token = ?, state = 'ok',
                  credential_version = credential_version + 1, last_refreshed_at = ?,
                  cooldown_until = '', next_probe_at = '', enabled = 1, updated_at = ?
            WHERE id = ?`,
          text(input.label),
          accessToken,
          refreshToken,
          idToken,
          now,
          now,
          accountId
        );
        this.sql.exec("DELETE FROM usage_current WHERE account_id = ?", accountId);
      } else {
        this.sql.exec(
          `INSERT INTO accounts
             (id, label, account_id, access_token, refresh_token, id_token, state,
              credential_version, last_refreshed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ok', 1, ?, ?, ?)`,
          accountId,
          text(input.label),
          tokens.accountId,
          accessToken,
          refreshToken,
          idToken,
          now,
          now,
          now
        );
      }
      const position = this.sql
        .exec<{ position: number }>(
          "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM group_members WHERE group_id = ?",
          DEFAULT_GROUP_ID
        )
        .one();
      this.sql.exec(
        "INSERT OR IGNORE INTO group_members (group_id, account_id, position, weight) VALUES (?, ?, ?, 1)",
        DEFAULT_GROUP_ID,
        accountId,
        Number(position.position)
      );
    });
    await this.scheduleNextAlarm();
    return json(
      {
        account: { id: accountId, accountId: tokens.accountId, label: text(input.label), state: "ok", enabled: true }
      },
      existing ? 200 : 201
    );
  }

  private async updateAccount(request: Request, id: string): Promise<Response> {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_ADMIN_BODY_BYTES) return jsonError(413, "body_too_large", "request body exceeds 1 MiB");
    let input: UpdateAccountRequest;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes)) as UpdateAccountRequest;
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }
    if (!input || typeof input !== "object") return jsonError(400, "invalid_request", "request body must be a JSON object");

    const current = this.sql.exec<AccountRow>("SELECT * FROM accounts WHERE id = ?", id).toArray()[0];
    if (!current) return jsonError(404, "not_found", "account not found");
    const hasLabel = Object.hasOwn(input, "label");
    const hasConcurrencyCap = Object.hasOwn(input, "concurrencyCap");
    const hasEnabled = Object.hasOwn(input, "enabled");
    if (!hasLabel && !hasConcurrencyCap && !hasEnabled) {
      return jsonError(400, "invalid_request", "label, concurrencyCap, or enabled is required");
    }
    const label = hasLabel ? text(input.label) : current.label;
    if (label.length > 80) return jsonError(400, "invalid_label", "account label must not exceed 80 characters");
    const concurrencyCap = hasConcurrencyCap ? Number(input.concurrencyCap) : Number(current.concurrency_cap);
    if (!Number.isInteger(concurrencyCap) || concurrencyCap < 0 || concurrencyCap > 100) {
      return jsonError(400, "invalid_concurrency_cap", "concurrencyCap must be an integer from 0 to 100");
    }
    if (hasEnabled && typeof input.enabled !== "boolean") {
      return jsonError(400, "invalid_enabled", "enabled must be a boolean");
    }
    const wasEnabled = Number(current.enabled) !== 0;
    const enabled = hasEnabled ? input.enabled as boolean : wasEnabled;
    const reenabled = enabled && !wasEnabled;
    const state = reenabled ? "unknown" : current.state;
    const cooldownUntil = reenabled ? "" : current.cooldown_until;
    const nextProbeAt = enabled && !reenabled ? current.next_probe_at : "";
    const updatedAt = new Date().toISOString();
    this.state.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE accounts
            SET label = ?, concurrency_cap = ?, enabled = ?, state = ?, cooldown_until = ?, next_probe_at = ?, updated_at = ?
          WHERE id = ?`,
        label,
        concurrencyCap,
        enabled ? 1 : 0,
        state,
        cooldownUntil,
        nextProbeAt,
        updatedAt,
        id
      );
    });
    await this.scheduleNextAlarm();
    return json({ account: this.safeAccount(this.getAccount(id)) });
  }

  private listPolicyGroups(): Response {
    const groups = this.sql
      .exec<{ id: string; name: string; strategy: Strategy }>(
        "SELECT id, name, strategy FROM policy_groups ORDER BY name ASC"
      )
      .toArray();
    return json({ policyGroups: groups.map((group) => this.policyGroupView(group)) });
  }

  private policyGroupView(group: { id: string; name: string; strategy: Strategy }): {
    id: string;
    name: string;
    strategy: Strategy;
    memberAccountIds: string[];
    memberWeights: Record<string, number>;
  } {
    const members = this.sql
      .exec<{ account_id: string; weight: number }>(
        "SELECT account_id, weight FROM group_members WHERE group_id = ? ORDER BY position ASC",
        group.id
      )
      .toArray();
    return {
      ...group,
      memberAccountIds: members.map((member) => member.account_id),
      memberWeights: Object.fromEntries(members.map((member) => [member.account_id, Number(member.weight)]))
    };
  }

  private parseStrategy(value: unknown): Strategy | null {
    return typeof value === "string" && STRATEGIES.has(value as Strategy) ? value as Strategy : null;
  }

  private parseGroupMembers(input: PolicyGroupRequest):
    | { memberAccountIds: string[]; memberWeights: Record<string, number> }
    | Response {
    if (!Array.isArray(input.memberAccountIds) || input.memberAccountIds.some((id) => typeof id !== "string")) {
      return jsonError(400, "invalid_members", "memberAccountIds must be an array of account IDs");
    }
    const memberAccountIds = [...new Set(input.memberAccountIds.map((id) => id.trim()))];
    if (memberAccountIds.length !== input.memberAccountIds.length || memberAccountIds.some((id) => !/^acct_[A-Za-z0-9]+$/.test(id))) {
      return jsonError(400, "invalid_members", "memberAccountIds contains a duplicate or invalid account ID");
    }
    const rawWeights = input.memberWeights === undefined ? {} : input.memberWeights;
    if (!rawWeights || typeof rawWeights !== "object" || Array.isArray(rawWeights)) {
      return jsonError(400, "invalid_weights", "memberWeights must be an object keyed by account ID");
    }
    const memberWeights: Record<string, number> = {};
    for (const [accountId, rawWeight] of Object.entries(rawWeights as Record<string, unknown>)) {
      const weight = Number(rawWeight);
      if (!memberAccountIds.includes(accountId) || !Number.isInteger(weight) || weight < 1 || weight > MAX_MEMBER_WEIGHT) {
        return jsonError(400, "invalid_weights", "member weights must target selected accounts and be integers from 1 to 1000000");
      }
      memberWeights[accountId] = weight;
    }
    for (const accountId of memberAccountIds) {
      if (!this.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE id = ?", accountId).toArray()[0]) {
        return jsonError(400, "unknown_account", `account ${accountId} does not exist`);
      }
    }
    return { memberAccountIds, memberWeights };
  }

  private replaceGroupMembers(groupId: string, memberAccountIds: string[], memberWeights: Record<string, number>): void {
    this.sql.exec("DELETE FROM group_members WHERE group_id = ?", groupId);
    memberAccountIds.forEach((accountId, position) => {
      this.sql.exec(
        "INSERT INTO group_members (group_id, account_id, position, weight) VALUES (?, ?, ?, ?)",
        groupId,
        accountId,
        position,
        memberWeights[accountId] ?? 1
      );
    });
  }

  private async createPolicyGroup(request: Request): Promise<Response> {
    const parsed = await this.readAdminJson<PolicyGroupRequest>(request);
    if (parsed instanceof Response) return parsed;
    const name = text(parsed.name);
    const strategy = this.parseStrategy(parsed.strategy);
    if (!name || name.length > 80) return jsonError(400, "invalid_name", "policy group name must contain 1 to 80 characters");
    if (!strategy) return jsonError(400, "invalid_strategy", "strategy is not supported");
    if (this.sql.exec<{ id: string }>("SELECT id FROM policy_groups WHERE name = ?", name).toArray()[0]) {
      return jsonError(409, "name_conflict", "policy group name is already in use");
    }
    const members = this.parseGroupMembers(parsed);
    if (members instanceof Response) return members;
    const id = randomId("group");
    this.state.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO policy_groups (id, name, strategy) VALUES (?, ?, ?)", id, name, strategy);
      this.replaceGroupMembers(id, members.memberAccountIds, members.memberWeights);
    });
    return json(this.policyGroupView({ id, name, strategy }), 201);
  }

  private async updatePolicyGroup(request: Request, id: string): Promise<Response> {
    const current = this.sql
      .exec<{ id: string; name: string; strategy: Strategy }>(
        "SELECT id, name, strategy FROM policy_groups WHERE id = ?",
        id
      )
      .toArray()[0];
    if (!current) return jsonError(404, "not_found", "policy group not found");
    const parsed = await this.readAdminJson<PolicyGroupRequest>(request);
    if (parsed instanceof Response) return parsed;
    const existingView = this.policyGroupView(current);
    const hasName = Object.hasOwn(parsed, "name");
    const hasStrategy = Object.hasOwn(parsed, "strategy");
    const hasMembers = Object.hasOwn(parsed, "memberAccountIds");
    const hasWeights = Object.hasOwn(parsed, "memberWeights");
    if (!hasName && !hasStrategy && !hasMembers && !hasWeights) {
      return jsonError(400, "invalid_request", "at least one policy group field is required");
    }
    const name = hasName ? text(parsed.name) : current.name;
    const strategy = hasStrategy ? this.parseStrategy(parsed.strategy) : current.strategy;
    if (!name || name.length > 80) return jsonError(400, "invalid_name", "policy group name must contain 1 to 80 characters");
    if (!strategy) return jsonError(400, "invalid_strategy", "strategy is not supported");
    const conflicting = this.sql.exec<{ id: string }>("SELECT id FROM policy_groups WHERE name = ? AND id <> ?", name, id).toArray()[0];
    if (conflicting) return jsonError(409, "name_conflict", "policy group name is already in use");
    const nextMemberIds = hasMembers ? parsed.memberAccountIds : existingView.memberAccountIds;
    const retainedWeights: Record<string, number> = {};
    if (!hasWeights && Array.isArray(nextMemberIds)) {
      for (const accountId of nextMemberIds) {
        if (typeof accountId === "string" && existingView.memberWeights[accountId]) {
          retainedWeights[accountId] = existingView.memberWeights[accountId];
        }
      }
    }
    const memberInput: PolicyGroupRequest = {
      memberAccountIds: nextMemberIds,
      memberWeights: hasWeights ? parsed.memberWeights : retainedWeights
    };
    const members = this.parseGroupMembers(memberInput);
    if (members instanceof Response) return members;
    this.state.storage.transactionSync(() => {
      this.sql.exec("UPDATE policy_groups SET name = ?, strategy = ? WHERE id = ?", name, strategy, id);
      this.replaceGroupMembers(id, members.memberAccountIds, members.memberWeights);
    });
    return json(this.policyGroupView({ id, name, strategy }));
  }

  private listEndpoints(): Response {
    const endpoints = this.sql
      .exec<{ name: string; group_id: string; group_name: string; strategy: Strategy }>(
        `SELECT endpoints.name, endpoints.group_id, policy_groups.name AS group_name, policy_groups.strategy
           FROM endpoints JOIN policy_groups ON policy_groups.id = endpoints.group_id
          ORDER BY endpoints.name ASC`
      )
      .toArray()
      .map((endpoint) => ({
        name: endpoint.name,
        groupId: endpoint.group_id,
        groupName: endpoint.group_name,
        strategy: endpoint.strategy
      }));
    return json({ endpoints });
  }

  private async createEndpoint(request: Request): Promise<Response> {
    const parsed = await this.readAdminJson<EndpointRequest>(request);
    if (parsed instanceof Response) return parsed;
    const name = text(parsed.name);
    const groupId = text(parsed.groupId);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      return jsonError(400, "invalid_name", "endpoint name may contain letters, digits, dot, underscore, and hyphen");
    }
    if (!this.sql.exec<{ id: string }>("SELECT id FROM policy_groups WHERE id = ?", groupId).toArray()[0]) {
      return jsonError(400, "unknown_policy_group", "policy group does not exist");
    }
    if (this.sql.exec<{ name: string }>("SELECT name FROM endpoints WHERE name = ?", name).toArray()[0]) {
      return jsonError(409, "name_conflict", "endpoint name is already in use");
    }
    this.state.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO endpoints (name, group_id) VALUES (?, ?)", name, groupId);
    });
    return json({ endpoint: { name, groupId } }, 201);
  }

  private async updateEndpoint(request: Request, name: string): Promise<Response> {
    if (!this.sql.exec<{ name: string }>("SELECT name FROM endpoints WHERE name = ?", name).toArray()[0]) {
      return jsonError(404, "not_found", "endpoint not found");
    }
    const parsed = await this.readAdminJson<EndpointRequest>(request);
    if (parsed instanceof Response) return parsed;
    const groupId = text(parsed.groupId);
    if (!groupId || !this.sql.exec<{ id: string }>("SELECT id FROM policy_groups WHERE id = ?", groupId).toArray()[0]) {
      return jsonError(400, "unknown_policy_group", "policy group does not exist");
    }
    this.state.storage.transactionSync(() => {
      this.sql.exec("UPDATE endpoints SET group_id = ? WHERE name = ?", groupId, name);
    });
    return json({ endpoint: { name, groupId } });
  }

  private async readAdminJson<T>(request: Request): Promise<T | Response> {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_ADMIN_BODY_BYTES) return jsonError(413, "body_too_large", "request body exceeds 1 MiB");
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as T;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : jsonError(400, "invalid_request", "request body must be a JSON object");
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }
  }

  private listApiKeys(): Response {
    const rows = this.sql
      .exec<{
        id: string;
        key_hint: string;
        label: string;
        endpoints: string;
        ip_allowlist: string;
        expires_at: string;
        created_at: string;
        key_version: number;
      }>("SELECT id, key_hint, label, endpoints, ip_allowlist, expires_at, created_at, key_version FROM api_keys ORDER BY created_at DESC")
      .toArray();
    return json({
      apiKeys: rows.map((row) => ({
        id: row.id,
        keyHint: row.key_hint,
        label: row.label,
        endpoints: this.parseEndpointScope(row.endpoints),
        ipAllowlist: this.parseIpAllowlistStrict(row.ip_allowlist) ?? [],
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        keyVersion: Number(row.key_version)
      }))
    });
  }

  private async createApiKey(request: Request): Promise<Response> {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_ADMIN_BODY_BYTES) return jsonError(413, "body_too_large", "request body exceeds 1 MiB");

    let input: CreateApiKeyRequest;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes)) as CreateApiKeyRequest;
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }

    const label = text(input.label);
    if (!label || label.length > 80) {
      return jsonError(400, "invalid_label", "API key label must contain 1 to 80 characters");
    }

    const scope = this.validateEndpointScope(input.endpoints ?? []);
    if (scope instanceof Response) return scope;
    const ipAllowlist = this.validateIpAllowlist(input.ipAllowlist ?? []);
    if (ipAllowlist instanceof Response) return ipAllowlist;

    let expiresAt = "";
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== "") {
      const days = Number(input.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return jsonError(400, "invalid_expiry", "expiresInDays must be an integer from 1 to 3650");
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
    }

    const secret = newApiKey();
    const hash = await sha256Hex(secret);
    const id = randomId("key");
    const createdAt = new Date().toISOString();
    this.state.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO api_keys (id, key_hash, key_hint, label, endpoints, ip_allowlist, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        hash,
        secret.slice(-8),
        label,
        JSON.stringify(scope),
        JSON.stringify(ipAllowlist),
        expiresAt,
        createdAt
      );
    });
    return json(
      {
        apiKey: secret,
        apiKeyNotice: "This Proxy API key is shown once. Store it now.",
        key: { id, keyHint: secret.slice(-8), label, endpoints: scope, ipAllowlist, expiresAt, createdAt, keyVersion: 1 }
      },
      201
    );
  }

  private async updateApiKey(request: Request, id: string): Promise<Response> {
    const current = this.sql
      .exec<{
        id: string;
        key_hint: string;
        label: string;
        endpoints: string;
        ip_allowlist: string;
        expires_at: string;
        created_at: string;
        key_version: number;
      }>("SELECT id, key_hint, label, endpoints, ip_allowlist, expires_at, created_at, key_version FROM api_keys WHERE id = ?", id)
      .toArray()[0];
    if (!current) return jsonError(404, "not_found", "API key not found");
    const parsed = await this.readAdminJson<UpdateApiKeyRequest>(request);
    if (parsed instanceof Response) return parsed;
    const hasLabel = Object.hasOwn(parsed, "label");
    const hasEndpoints = Object.hasOwn(parsed, "endpoints");
    const hasExpiry = Object.hasOwn(parsed, "expiresInDays");
    const hasIpAllowlist = Object.hasOwn(parsed, "ipAllowlist");
    if (!hasLabel && !hasEndpoints && !hasExpiry && !hasIpAllowlist) {
      return jsonError(400, "invalid_request", "at least one API key metadata field is required");
    }

    const label = hasLabel ? text(parsed.label) : current.label;
    if (!label || label.length > 80) {
      return jsonError(400, "invalid_label", "API key label must contain 1 to 80 characters");
    }
    const currentEndpoints = this.parseEndpointScopeStrict(current.endpoints);
    if (!hasEndpoints && currentEndpoints === null) {
      return jsonError(500, "invalid_stored_scope", "stored API key endpoint scope is invalid");
    }
    const endpoints = hasEndpoints ? this.validateEndpointScope(parsed.endpoints) : currentEndpoints!;
    if (endpoints instanceof Response) return endpoints;
    const currentIpAllowlist = this.parseIpAllowlistStrict(current.ip_allowlist);
    if (!hasIpAllowlist && currentIpAllowlist === null) {
      return jsonError(500, "invalid_stored_ip_allowlist", "stored API key IP allowlist is invalid");
    }
    const ipAllowlist = hasIpAllowlist ? this.validateIpAllowlist(parsed.ipAllowlist) : currentIpAllowlist!;
    if (ipAllowlist instanceof Response) return ipAllowlist;
    let expiresAt = current.expires_at;
    if (hasExpiry) {
      if (parsed.expiresInDays === null || parsed.expiresInDays === "") {
        expiresAt = "";
      } else {
        const days = Number(parsed.expiresInDays);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          return jsonError(400, "invalid_expiry", "expiresInDays must be null or an integer from 1 to 3650");
        }
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
      }
    }
    this.state.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE api_keys SET label = ?, endpoints = ?, ip_allowlist = ?, expires_at = ? WHERE id = ?",
        label,
        JSON.stringify(endpoints),
        JSON.stringify(ipAllowlist),
        expiresAt,
        id
      );
    });
    return json({
      key: {
        id,
        keyHint: current.key_hint,
        label,
        endpoints,
        ipAllowlist,
        expiresAt,
        createdAt: current.created_at,
        keyVersion: Number(current.key_version)
      }
    });
  }

  private validateEndpointScope(value: unknown): string[] | Response {
    if (!Array.isArray(value) || value.some((endpoint) => typeof endpoint !== "string")) {
      return jsonError(400, "invalid_endpoints", "endpoints must be an array of endpoint names");
    }
    const scope = [...new Set(value.map((endpoint) => endpoint.trim()))];
    if (scope.length !== value.length || scope.some((endpoint) => !/^[A-Za-z0-9._-]{1,64}$/.test(endpoint))) {
      return jsonError(400, "invalid_endpoints", "endpoint scope contains a duplicate or invalid name");
    }
    for (const endpoint of scope) {
      if (!this.sql.exec<{ name: string }>("SELECT name FROM endpoints WHERE name = ?", endpoint).toArray()[0]) {
        return jsonError(400, "unknown_endpoint", `endpoint ${endpoint} does not exist`);
      }
    }
    return scope;
  }

  private validateIpAllowlist(value: unknown): string[] | Response {
    try {
      return normalizeIpAllowlist(value);
    } catch (error) {
      return jsonError(400, "invalid_ip_allowlist", error instanceof Error ? error.message : "invalid IP allowlist");
    }
  }

  private parseIpAllowlistStrict(value: string): string[] | null {
    try {
      return normalizeIpAllowlist(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }

  private deleteApiKey(id: string): Response {
    let deleted = false;
    this.state.storage.transactionSync(() => {
      deleted = this.sql.exec<{ id: string }>("DELETE FROM api_keys WHERE id = ? RETURNING id", id).toArray().length === 1;
    });
    return deleted ? new Response(null, { status: 204 }) : jsonError(404, "not_found", "API key not found");
  }

  private async regenerateApiKey(request: Request, id: string): Promise<Response> {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_ADMIN_BODY_BYTES) return jsonError(413, "body_too_large", "request body exceeds 1 MiB");
    let expectedVersion: number;
    try {
      const input = JSON.parse(new TextDecoder().decode(bytes)) as { expectedVersion?: unknown };
      expectedVersion = Number(input.expectedVersion);
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return jsonError(400, "invalid_version", "expectedVersion must be a positive integer");
    }

    const secret = newApiKey();
    const hash = await sha256Hex(secret);
    const keyHint = secret.slice(-8);
    let updated = false;
    this.state.storage.transactionSync(() => {
      updated = this.sql
        .exec<{ id: string }>(
          `UPDATE api_keys
              SET key_hash = ?, key_hint = ?, key_version = key_version + 1
            WHERE id = ? AND key_version = ?
            RETURNING id`,
          hash,
          keyHint,
          id,
          expectedVersion
        )
        .toArray().length === 1;
    });

    if (!updated) {
      const stillExists = this.sql.exec<{ id: string }>("SELECT id FROM api_keys WHERE id = ?", id).toArray()[0];
      return stillExists
        ? jsonError(409, "regeneration_conflict", "API key changed concurrently; regenerate again")
        : jsonError(404, "not_found", "API key not found");
    }

    return json({
      apiKey: secret,
      apiKeyNotice: "This regenerated Proxy API key is shown once. The previous key is invalid.",
      key: { id, keyHint, keyVersion: expectedVersion + 1 }
    });
  }

  private parseEndpointScope(value: string): string[] {
    return this.parseEndpointScopeStrict(value) ?? [];
  }

  private parseEndpointScopeStrict(value: string): string[] | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
    } catch {
      return null;
    }
  }

  private async handleProxy(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && url.pathname === "/readyz") return this.readiness();
    const endpoint = endpointFromPath(url.pathname);
    if (!endpoint) {
      await discardRequestBody(request);
      return jsonError(404, "not_found", "proxy route not found");
    }
    const apiKey = await this.authorizeApiKey(request, endpoint);
    if (apiKey instanceof Response) {
      await discardRequestBody(request);
      return apiKey;
    }
    if (!apiKey) {
      await discardRequestBody(request);
      return jsonError(401, "invalid_api_key", "a valid Poolgate Edge API key is required");
    }
    const resolution = this.resolveEndpoint(endpoint);
    if (!resolution) {
      await discardRequestBody(request);
      return jsonError(404, "unknown_endpoint", "endpoint does not exist");
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET") return jsonError(405, "method_not_allowed", "WebSocket upgrades must use GET");
      return this.proxyWebSocket(request, resolution);
    }
    if (request.method !== "POST") {
      await discardRequestBody(request);
      return jsonError(405, "method_not_allowed", "use POST for response requests");
    }
    return this.proxyHttp(request, resolution);
  }

  private readiness(): Response {
    const endpoints = this.sql.exec<{ name: string }>("SELECT name FROM endpoints ORDER BY name ASC").toArray();
    const ready = endpoints.some((endpoint) =>
      this.resolveEndpoint(endpoint.name)?.accounts.some((account) => isEligible(account)) === true
    );
    return ready
      ? json({ ready: true })
      : json({ ready: false, reason: "no_eligible_route" }, 503);
  }

  private async authorizeApiKey(request: Request, endpoint: string): Promise<SelectedApiKey | Response | null> {
    const secret = bearerToken(request);
    if (!secret) return null;
    const hash = await sha256Hex(secret);
    const row = this.sql
      .exec<{ id: string; label: string; endpoints: string; ip_allowlist: string; expires_at: string }>(
        "SELECT id, label, endpoints, ip_allowlist, expires_at FROM api_keys WHERE key_hash = ?",
        hash
      )
      .toArray()[0];
    if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return null;
    const endpoints = this.parseEndpointScopeStrict(row.endpoints);
    if (endpoints === null) return null;
    if (endpoints.length > 0 && !endpoints.includes(endpoint)) return null;
    const ipAllowlist = this.parseIpAllowlistStrict(row.ip_allowlist);
    if (ipAllowlist === null) return null;
    if (ipAllowlist.length > 0 && !matchesIpAllowlist(request.headers.get("x-poolgate-client-ip") ?? "", ipAllowlist)) {
      return jsonError(403, "api_key_ip_denied", "this API key is not allowed from the current client IP");
    }
    return { id: row.id, label: row.label, endpoints, ipAllowlist };
  }

  private resolveEndpoint(endpoint: string): EndpointResolution | null {
    const group = this.sql
      .exec<{ id: string; name: string; strategy: Strategy }>(
        `SELECT policy_groups.id, policy_groups.name, policy_groups.strategy
           FROM endpoints JOIN policy_groups ON policy_groups.id = endpoints.group_id
          WHERE endpoints.name = ?`,
        endpoint
      )
      .toArray()[0];
    if (!group) return null;
    const rows = this.sql
      .exec<AccountRow>(
        `SELECT accounts.*, group_members.position, group_members.weight,
                COALESCE(usage_current.windows, '[]') AS windows
           FROM group_members
           JOIN accounts ON accounts.id = group_members.account_id
           LEFT JOIN usage_current ON usage_current.account_id = accounts.id
          WHERE group_members.group_id = ?
          ORDER BY group_members.position ASC`,
        group.id
      )
      .toArray();
    const accounts: CandidateAccount[] = rows.map((row) => ({
      ...rowToAccount(row),
      position: Number(row.position ?? 0),
      weight: Number(row.weight ?? 1),
      headroom: headroomFromStoredWindows(row.windows)
    }));
    return { endpoint, group, accounts };
  }

  private async proxyHttp(request: Request, resolution: EndpointResolution): Promise<Response> {
    const availability = this.availabilityResponse(resolution);
    if (availability) {
      await discardRequestBody(request);
      return availability;
    }
    const bodyResult = await this.streamingRequestBody(request);
    if (bodyResult instanceof Response) return bodyResult;
    const excluded = new Set<string>();
    let lastStatus = 503;
    let lastMessage = "no eligible account is available";

    while (excluded.size < resolution.accounts.length) {
      const account = await this.selectForRequest(request, resolution, excluded);
      if (!account) {
        if (excluded.size === 0) {
          const changedAvailability = this.availabilityResponse(resolution);
          if (changedAvailability) return changedAvailability;
        }
        break;
      }
      this.acquire(account.id);
      let committed = false;
      try {
        let credentials = await this.decryptAccount(account);
        let refreshed = false;

        for (;;) {
          let upstream: Response;
          try {
            upstream = await fetch(this.upstreamUrl(), {
              method: "POST",
              headers: this.upstreamHeaders(request, credentials),
              body: bodyResult,
              redirect: "error",
              signal: request.signal
            });
          } catch {
            if (request.signal.aborted) {
              return jsonError(408, "request_cancelled", "request was cancelled before the upstream response committed");
            }
            lastMessage = "upstream connection failed";
            this.markState(account.id, "cooldown", new Date(Date.now() + 30_000).toISOString());
            break;
          }

          if (upstream.status === 401) {
            upstream.body?.cancel().catch(() => undefined);
            if (!refreshed) {
            try {
              credentials = await this.refreshAccount(account.id, credentials.credentialVersion);
              refreshed = true;
              continue;
            } catch (error) {
              lastStatus = 502;
              if (error instanceof OAuthRefreshFailure && error.terminal) {
                this.markState(account.id, "expired", "");
                lastMessage = "account authorization expired";
              } else {
                this.markState(account.id, "cooldown", new Date(Date.now() + 30_000).toISOString());
                lastMessage = "account credential refresh is temporarily unavailable";
              }
              break;
            }
          }
          if (!refreshed) break;
          this.markState(account.id, "expired", "");
            lastStatus = 502;
            lastMessage = "account authorization expired";
            break;
          }
          if (RETRYABLE_STATUS.has(upstream.status)) {
            lastStatus = upstream.status;
            lastMessage = "upstream temporarily unavailable";
            this.markState(account.id, "cooldown", new Date(Date.now() + retryAfter(upstream)).toISOString());
            upstream.body?.cancel().catch(() => undefined);
            break;
          }
          this.markStateSafe(account.id, "ok", "");
          await this.rememberTurnAffinitySafe(upstream.headers.get("x-codex-turn-state"), account.id);
          const response = this.streamResponse(upstream, account.id);
          committed = true;
          return response;
        }
      } finally {
        if (!committed) this.release(account.id);
      }
      excluded.add(account.id);
    }
    return jsonError(lastStatus, "upstream_unavailable", lastMessage);
  }

  private async proxyWebSocket(request: Request, resolution: EndpointResolution): Promise<Response> {
    const availability = this.availabilityResponse(resolution);
    if (availability) return availability;
    const excluded = new Set<string>();
    let lastStatus = 502;
    let lastMessage = "all eligible accounts rejected the WebSocket handshake";
    while (excluded.size < resolution.accounts.length) {
      const account = await this.selectForRequest(request, resolution, excluded);
      if (!account) {
        if (excluded.size === 0) {
          const changedAvailability = this.availabilityResponse(resolution);
          if (changedAvailability) return changedAvailability;
        }
        break;
      }
      this.acquire(account.id);
      let committed = false;
      try {
        let credentials = await this.decryptAccount(account);
        let refreshed = false;

        for (;;) {
          let upstreamResponse: Response;
          try {
            const headers = this.upstreamHeaders(request, credentials, "websocket");
            headers.set("upgrade", "websocket");
            upstreamResponse = await fetch(this.upstreamUrl(), { headers, redirect: "error", signal: request.signal });
          } catch {
            if (request.signal.aborted) {
              return jsonError(408, "request_cancelled", "request was cancelled before the WebSocket handshake committed");
            }
            lastMessage = "upstream WebSocket connection failed";
            this.markState(account.id, "cooldown", new Date(Date.now() + 30_000).toISOString());
            break;
          }
          if (upstreamResponse.status === 401) {
            upstreamResponse.body?.cancel().catch(() => undefined);
            if (!refreshed) {
            try {
              credentials = await this.refreshAccount(account.id, credentials.credentialVersion);
              refreshed = true;
              continue;
            } catch (error) {
              if (error instanceof OAuthRefreshFailure && error.terminal) {
                this.markState(account.id, "expired", "");
                lastMessage = "account authorization expired";
              } else {
                this.markState(account.id, "cooldown", new Date(Date.now() + 30_000).toISOString());
                lastMessage = "account credential refresh is temporarily unavailable";
              }
              break;
            }
          }
          if (!refreshed) break;
          this.markState(account.id, "expired", "");
            lastMessage = "account authorization expired";
            break;
          }
          if (upstreamResponse.status !== 101 || !upstreamResponse.webSocket) {
            if (RETRYABLE_STATUS.has(upstreamResponse.status)) {
              lastStatus = upstreamResponse.status;
              lastMessage = "upstream temporarily unavailable";
              this.markState(account.id, "cooldown", new Date(Date.now() + retryAfter(upstreamResponse)).toISOString());
              upstreamResponse.body?.cancel().catch(() => undefined);
              break;
            }
            upstreamResponse.body?.cancel().catch(() => undefined);
            const rejectionStatus = upstreamResponse.status >= 400 && upstreamResponse.status < 500
              ? upstreamResponse.status
              : 502;
            return jsonError(rejectionStatus, "upstream_rejected", "upstream rejected the WebSocket handshake");
          }

          const upstream = upstreamResponse.webSocket;
          upstream.accept();
          const pair = new WebSocketPair();
          const client = pair[0];
          const server = pair[1];
          server.accept();
          let closed = false;
          const finish = (code = 1000, reason = "") => {
            if (closed) return;
            closed = true;
            this.release(account.id);
            const close = normalizeClose(code, reason);
            try { server.close(close.code, close.reason); } catch { /* already closed */ }
            try { upstream.close(close.code, close.reason); } catch { /* already closed */ }
          };
          const maximumMessageBytes = Math.max(1, Number(this.env.MAX_REQUEST_BODY_BYTES) || 8 * 1024 * 1024);
          const relay = (destination: WebSocket, data: string | ArrayBuffer) => {
            const size = webSocketMessageBytes(data);
            if (size > maximumMessageBytes) {
              finish(1009, "message too large");
              return;
            }
            try {
              destination.send(data);
            } catch {
              finish(1011, "socket send failed");
            }
          };
          server.addEventListener("message", (event) => relay(upstream, event.data));
          upstream.addEventListener("message", (event) => relay(server, event.data));
          server.addEventListener("close", (event) => finish(event.code, event.reason));
          upstream.addEventListener("close", (event) => finish(event.code, event.reason));
          server.addEventListener("error", () => finish(1011, "client socket error"));
          upstream.addEventListener("error", () => finish(1011, "upstream socket error"));
          this.markStateSafe(account.id, "ok", "");
          await this.rememberTurnAffinitySafe(
            upstreamResponse.headers.get("x-codex-turn-state") ?? request.headers.get("x-codex-turn-state"),
            account.id
          );
          const responseHeaders = new Headers();
          const protocol = upstreamResponse.headers.get("sec-websocket-protocol");
          if (protocol) responseHeaders.set("sec-websocket-protocol", protocol);
          const response = new Response(null, { status: 101, headers: responseHeaders, webSocket: client });
          committed = true;
          return response;
        }
      } finally {
        if (!committed) this.release(account.id);
      }
      excluded.add(account.id);
    }
    return jsonError(lastStatus, "upstream_unavailable", lastMessage);
  }

  private availabilityResponse(resolution: EndpointResolution): Response | null {
    const availability = accountAvailability(resolution.accounts, this.selection);
    if (availability === "saturated") {
      return json(
        { error: { type: "backpressure", message: "all eligible accounts are at their concurrency limit" } },
        429,
        { "retry-after": "1" }
      );
    }
    if (availability === "unavailable") {
      return jsonError(503, "no_eligible_account", "no eligible account is available for this endpoint");
    }
    return null;
  }

  private async streamingRequestBody(request: Request): Promise<ArrayBuffer | Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    const maximum = Math.max(1, Number(this.env.MAX_REQUEST_BODY_BYTES) || 8 * 1024 * 1024);
    if (body.byteLength > maximum) return jsonError(413, "body_too_large", `request body exceeds ${maximum} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return jsonError(400, "invalid_json", "request body must be JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError(400, "invalid_request", "request body must be a JSON object");
    }
    (parsed as Record<string, unknown>).stream = true;
    const encoded = new TextEncoder().encode(JSON.stringify(parsed));
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  }

  private upstreamHeaders(request: Request, account: DecryptedAccount, transport: "http" | "websocket" = "http"): Headers {
    const headers = new Headers();
    for (const name of [
      "idempotency-key", "openai-beta", "originator", "user-agent", "x-codex-turn-state",
      "x-client-request-id", "x-codex-installation-id", "x-codex-routing-hint", "sec-websocket-protocol"
    ]) {
      const value = request.headers.get(name)?.trim();
      if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${account.accessToken}`);
    headers.set("chatgpt-account-id", account.accountId);
    if (transport === "http") {
      headers.set("accept", "text/event-stream");
      headers.set("content-type", "application/json");
    }
    if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
    if (!headers.has("user-agent")) headers.set("user-agent", "codex_cli_rs");
    if (!headers.has("openai-beta")) {
      headers.set("openai-beta", transport === "websocket" ? "responses_websockets=2026-02-06" : "responses=experimental");
    }
    return headers;
  }

  private upstreamUrl(): string {
    const configured = new URL(this.env.UPSTREAM_BASE);
    if (
      configured.protocol !== "https:" ||
      configured.hostname !== "chatgpt.com" ||
      configured.pathname.replace(/\/$/, "") !== "/backend-api/codex" ||
      configured.username ||
      configured.password ||
      configured.search ||
      configured.hash
    ) {
      throw new Error("UPSTREAM_BASE must be https://chatgpt.com/backend-api/codex");
    }
    return `${configured.toString().replace(/\/$/, "")}/responses`;
  }

  private async selectForRequest(
    request: Request,
    resolution: EndpointResolution,
    excluded: Set<string>
  ): Promise<CandidateAccount | null> {
    const turnState = request.headers.get("x-codex-turn-state");
    if (turnState) {
      const hash = await sha256Hex(turnState);
      const affinity = this.sql
        .exec<{ account_id: string; expires_at: string }>(
          "SELECT account_id, expires_at FROM turn_affinity WHERE turn_state_hash = ?",
          hash
        )
        .toArray()[0];
      if (affinity && Date.parse(affinity.expires_at) > Date.now()) {
        const preferred = resolution.accounts.find((candidate) => candidate.id === affinity.account_id);
        if (preferred && !excluded.has(preferred.id) && isEligible(preferred) && hasCapacity(preferred, this.selection)) {
          return preferred;
        }
      }
    }
    return selectAccount(resolution.group.id, resolution.group.strategy, resolution.accounts, this.selection, excluded);
  }

  private async rememberTurnAffinity(turnState: string | null, accountId: string): Promise<void> {
    if (!turnState) return;
    const hash = await sha256Hex(turnState);
    const now = Date.now();
    const expiresAt = new Date(now + TURN_AFFINITY_TTL_MS).toISOString();
    this.state.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM turn_affinity WHERE expires_at <= ?", new Date(now).toISOString());
      const existing = this.sql.exec<{ turn_state_hash: string }>(
        "SELECT turn_state_hash FROM turn_affinity WHERE turn_state_hash = ?",
        hash
      ).toArray()[0];
      if (!existing) {
        const count = Number(this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM turn_affinity").one().count);
        if (count >= TURN_AFFINITY_MAX) {
          this.sql.exec(
            `DELETE FROM turn_affinity WHERE turn_state_hash IN (
               SELECT turn_state_hash FROM turn_affinity ORDER BY expires_at ASC LIMIT ?
             )`,
            count - TURN_AFFINITY_MAX + 1
          );
        }
      }
      this.sql.exec(
        `INSERT INTO turn_affinity (turn_state_hash, account_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(turn_state_hash) DO UPDATE SET account_id = excluded.account_id, expires_at = excluded.expires_at`,
        hash,
        accountId,
        expiresAt
      );
    });
    await this.scheduleNextAlarm();
  }

  private async rememberTurnAffinitySafe(turnState: string | null, accountId: string): Promise<void> {
    try {
      await this.rememberTurnAffinity(turnState, accountId);
    } catch (error) {
      console.warn("turn affinity update failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  private usageUrl(): string {
    const responseUrl = new URL(this.upstreamUrl());
    return `${responseUrl.origin}/backend-api/wham/usage`;
  }

  private usageHeaders(account: DecryptedAccount): Headers {
    return new Headers({
      accept: "application/json",
      authorization: `Bearer ${account.accessToken}`,
      "chatgpt-account-id": account.accountId,
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs"
    });
  }

  private async readUsageJson(response: Response): Promise<unknown> {
    if (!response.body) throw new Error("usage response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_USAGE_BODY_BYTES) throw new Error("usage response exceeds 1 MiB");
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  }

  private async pollAccountUsage(accountId: string): Promise<CurrentUsage | Response> {
    const row = this.sql.exec<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId).toArray()[0];
    if (!row) return jsonError(404, "not_found", "account not found");
    if (!row.enabled) return jsonError(409, "account_disabled", "disabled account cannot be probed");
    if (row.state === "revoked" || row.state === "dead") {
      return jsonError(409, "account_not_probeable", "terminal account cannot be probed");
    }

    let credentials = await this.decryptAccount(rowToAccount(row));
    let refreshed = false;
    for (;;) {
      let response: Response;
      try {
        response = await fetch(this.usageUrl(), {
          method: "GET",
          headers: this.usageHeaders(credentials),
          redirect: "error",
          signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS)
        });
      } catch {
        this.deferProbe(accountId);
        return jsonError(502, "usage_unavailable", "account usage is temporarily unavailable");
      }

      if (response.status === 401) {
        response.body?.cancel().catch(() => undefined);
        if (refreshed) {
          this.markState(accountId, "expired", "");
          return jsonError(502, "account_authorization_expired", "account authorization expired after refresh");
        }
        try {
          credentials = await this.refreshAccount(accountId, credentials.credentialVersion);
          refreshed = true;
          continue;
        } catch (error) {
          if (error instanceof OAuthRefreshFailure && error.terminal) {
            this.markState(accountId, "expired", "");
            return jsonError(502, "account_authorization_expired", "account authorization expired");
          }
          this.markState(accountId, "cooldown", new Date(Date.now() + 30_000).toISOString());
          return jsonError(502, "credential_refresh_unavailable", "account credential refresh is temporarily unavailable");
        }
      }

      if (response.status === 429) {
        const until = new Date(Date.now() + retryAfter(response, MAX_USAGE_RETRY_AFTER_MS)).toISOString();
        response.body?.cancel().catch(() => undefined);
        this.markState(accountId, "cooldown", until);
        return jsonError(502, "usage_rate_limited", "account usage polling is temporarily rate limited");
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        this.deferProbe(accountId);
        return jsonError(502, "usage_unavailable", "account usage is temporarily unavailable");
      }

      let parsed: ReturnType<typeof parseUsagePayload>;
      try {
        parsed = parseUsagePayload(await this.readUsageJson(response));
      } catch {
        this.deferProbe(accountId);
        return jsonError(502, "invalid_usage_response", "account usage response is invalid");
      }

      const now = Date.now();
      const capturedAt = new Date(now).toISOString();
      const headroom = minimumHeadroom(parsed.windows);
      const current = this.sql
        .exec<{ state: AccountRecord["state"]; cooldown_until: string; enabled: number }>(
          "SELECT state, cooldown_until, enabled FROM accounts WHERE id = ?",
          accountId
        )
        .toArray()[0];
      if (!current) return jsonError(404, "not_found", "account not found");
      if (!current.enabled) return jsonError(409, "account_disabled", "account was disabled during the usage check");
      const currentGate = Date.parse(current.cooldown_until);
      let nextState: AccountRecord["state"] = "ok";
      let cooldownUntil = "";
      let nextProbeAt = new Date(now + HEALTHY_PROBE_INTERVAL_MS).toISOString();
      if (headroom <= 0) {
        nextState = "quota_exhausted";
        cooldownUntil = exhaustedReset(parsed.windows, now) || new Date(now + 60_000).toISOString();
        nextProbeAt = cooldownUntil;
      } else if (
        (current.state === "cooldown" || current.state === "quota_exhausted") &&
        Number.isFinite(currentGate) && currentGate > now
      ) {
        nextState = current.state;
        cooldownUntil = current.cooldown_until;
        nextProbeAt = current.cooldown_until;
      }

      this.state.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO usage_current (account_id, plan_type, windows, captured_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             plan_type = excluded.plan_type, windows = excluded.windows, captured_at = excluded.captured_at`,
          accountId,
          parsed.planType,
          JSON.stringify(parsed.windows),
          capturedAt
        );
        this.sql.exec(
          "UPDATE accounts SET state = ?, cooldown_until = ?, next_probe_at = ?, updated_at = ? WHERE id = ?",
          nextState,
          cooldownUntil,
          nextProbeAt,
          capturedAt,
          accountId
        );
      });
      await this.scheduleNextAlarm();
      return { ...parsed, capturedAt, headroom };
    }
  }

  private deferProbe(accountId: string): void {
    const row = this.sql
      .exec<{ state: AccountRecord["state"]; cooldown_until: string; enabled: number }>(
        "SELECT state, cooldown_until, enabled FROM accounts WHERE id = ?",
        accountId
      )
      .toArray()[0];
    if (!row || !row.enabled) return;
    const gate = Date.parse(row.cooldown_until);
    const delay = row.state === "expired" ? EXPIRED_PROBE_INTERVAL_MS : FAILED_PROBE_INTERVAL_MS;
    const next = Number.isFinite(gate) && gate > Date.now()
      ? row.cooldown_until
      : new Date(Date.now() + delay).toISOString();
    this.state.storage.transactionSync(() => {
      this.sql.exec("UPDATE accounts SET next_probe_at = ? WHERE id = ?", next, accountId);
    });
    this.state.waitUntil(this.scheduleNextAlarm());
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    const accounts = this.sql
      .exec<{ next_probe_at: string; cooldown_until: string }>(
        "SELECT next_probe_at, cooldown_until FROM accounts WHERE enabled = 1 AND state NOT IN ('revoked', 'dead')"
      )
      .toArray();
    for (const account of accounts) {
      const probe = Date.parse(account.next_probe_at);
      const gate = Date.parse(account.cooldown_until);
      let candidate = Number.isFinite(probe) ? probe : now + MIN_ALARM_DELAY_MS;
      if (Number.isFinite(gate) && gate > candidate) candidate = gate;
      next = Math.min(next, candidate);
    }
    const affinity = this.sql
      .exec<{ expires_at: string }>("SELECT MIN(expires_at) AS expires_at FROM turn_affinity")
      .toArray()[0];
    const affinityExpiry = Date.parse(affinity?.expires_at ?? "");
    if (Number.isFinite(affinityExpiry)) next = Math.min(next, affinityExpiry);
    if (!Number.isFinite(next)) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(now + MIN_ALARM_DELAY_MS, next));
  }

  private acquire(accountId: string): void {
    this.selection.inFlight.set(accountId, (this.selection.inFlight.get(accountId) ?? 0) + 1);
  }

  private release(accountId: string): void {
    const next = Math.max(0, (this.selection.inFlight.get(accountId) ?? 1) - 1);
    if (next === 0) this.selection.inFlight.delete(accountId);
    else this.selection.inFlight.set(accountId, next);
  }

  private streamResponse(response: Response, accountId: string): Response {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    if (!response.body) {
      this.release(accountId);
      return new Response(null, { status: response.status, statusText: response.statusText, headers });
    }
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    this.state.waitUntil(
      response.body.pipeTo(stream.writable).finally(() => this.release(accountId))
    );
    return new Response(stream.readable, { status: response.status, statusText: response.statusText, headers });
  }

  private markState(accountId: string, state: AccountRecord["state"], cooldownUntil: string): void {
    const now = Date.now();
    const existing = this.sql
      .exec<{ next_probe_at: string }>("SELECT next_probe_at FROM accounts WHERE id = ?", accountId)
      .toArray()[0];
    const currentProbe = Date.parse(existing?.next_probe_at ?? "");
    let nextProbeAt = new Date(now + HEALTHY_PROBE_INTERVAL_MS).toISOString();
    if (state === "cooldown" || state === "quota_exhausted") {
      const gate = Date.parse(cooldownUntil);
      nextProbeAt = Number.isFinite(gate) && gate > now
        ? cooldownUntil
        : new Date(now + 60_000).toISOString();
    } else if (state === "expired") {
      nextProbeAt = new Date(now + EXPIRED_PROBE_INTERVAL_MS).toISOString();
    } else if (state === "ok" && Number.isFinite(currentProbe) && currentProbe > now) {
      nextProbeAt = existing.next_probe_at;
    }
    this.state.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE accounts SET state = ?, cooldown_until = ?, next_probe_at = ?, updated_at = ? WHERE id = ?",
        state,
        cooldownUntil,
        nextProbeAt,
        new Date().toISOString(),
        accountId
      );
    });
    this.state.waitUntil(this.scheduleNextAlarm());
  }

  private markStateSafe(accountId: string, state: AccountRecord["state"], cooldownUntil: string): void {
    try {
      this.markState(accountId, state, cooldownUntil);
    } catch (error) {
      console.warn("account state update failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  private async decryptAccount(account: AccountRecord): Promise<DecryptedAccount> {
    const key = await this.masterKey;
    const [accessToken, refreshToken, idToken] = await Promise.all([
      decryptSecret(key, account.accessTokenCiphertext),
      decryptSecret(key, account.refreshTokenCiphertext),
      decryptSecret(key, account.idTokenCiphertext)
    ]);
    return { ...account, accessToken, refreshToken, idToken };
  }

  private getAccount(accountId: string): AccountRecord {
    const row = this.sql.exec<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId).toArray()[0];
    if (!row) throw new Error("account not found");
    return rowToAccount(row);
  }

  private async refreshAccount(accountId: string, observedVersion: number): Promise<DecryptedAccount> {
    const existing = this.refreshes.get(accountId);
    if (existing) return existing;
    const current = this.getAccount(accountId);
    if (current.credentialVersion !== observedVersion) return this.decryptAccount(current);
    const refresh = this.performRefresh(accountId, observedVersion).finally(() => this.refreshes.delete(accountId));
    this.refreshes.set(accountId, refresh);
    return refresh;
  }

  private async performRefresh(accountId: string, observedVersion: number): Promise<DecryptedAccount> {
    await this.reconcileRotation(accountId);
    const before = await this.decryptAccount(this.getAccount(accountId));
    if (before.credentialVersion !== observedVersion) return before;
    const issuer = new URL(this.env.OAUTH_ISSUER);
    if (
      issuer.protocol !== "https:" ||
      issuer.hostname !== "auth.openai.com" ||
      issuer.pathname !== "/oauth/token" ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    ) throw new Error("OAUTH_ISSUER must be https://auth.openai.com/oauth/token");
    const response = await fetch(issuer, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: before.refreshToken,
        client_id: this.env.OAUTH_CLIENT_ID
      }),
      redirect: "error"
    });
    if (!response.ok) {
      let code = "";
      try {
        const failure = (await response.json()) as OAuthResponse;
        code = text(failure.error);
      } catch {
        // A malformed failure response is transient unless the issuer explicitly
        // identifies the refresh token as invalid_grant.
      }
      throw new OAuthRefreshFailure(response.status, code);
    }
    const payload = (await response.json()) as OAuthResponse;
    const accessToken = text(payload.access_token);
    const refreshToken = text(payload.refresh_token) || before.refreshToken;
    const idToken = text(payload.id_token) || before.idToken;
    if (!accessToken) throw new Error("OAuth response has no access token");

    const key = await this.masterKey;
    const [accessTokenCiphertext, refreshTokenCiphertext, idTokenCiphertext] = await Promise.all([
      encryptSecret(key, accessToken), encryptSecret(key, refreshToken), encryptSecret(key, idToken)
    ]);
    const journal: RotationJournalEntry = {
      accountId,
      baseVersion: before.credentialVersion,
      targetVersion: before.credentialVersion + 1,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      idTokenCiphertext,
      createdAt: new Date().toISOString()
    };
    const journalKey = this.rotationKey(accountId);
    const committed = await persistCredentialRotation(journal, {
      writeJournal: async (entry) => {
        await this.env.ROTATION_JOURNAL.put(journalKey, JSON.stringify(entry), {
          httpMetadata: { contentType: "application/json" }
        });
      },
      compareAndSwap: (entry) => {
        let updated = false;
        this.state.storage.transactionSync(() => {
          updated = this.sql
            .exec<{ id: string }>(
              `UPDATE accounts
                  SET access_token = ?, refresh_token = ?, id_token = ?, credential_version = ?,
                      state = 'ok', cooldown_until = '', last_refreshed_at = ?, updated_at = ?
                WHERE id = ? AND credential_version = ? RETURNING id`,
              entry.accessTokenCiphertext,
              entry.refreshTokenCiphertext,
              entry.idTokenCiphertext,
              entry.targetVersion,
              entry.createdAt,
              entry.createdAt,
              accountId,
              entry.baseVersion
            )
            .toArray().length === 1;
        });
        return updated;
      },
      removeJournal: async () => this.env.ROTATION_JOURNAL.delete(journalKey)
    });
    if (committed.cleanupPending) console.warn("credential rotation journal cleanup is pending", accountId);
    return committed.updated
      ? { ...this.getAccount(accountId), accessToken, refreshToken, idToken }
      : this.decryptAccount(this.getAccount(accountId));
  }

  private async reconcileRotation(accountId: string): Promise<void> {
    const key = this.rotationKey(accountId);
    const object = await this.env.ROTATION_JOURNAL.get(key);
    if (!object) return;
    const journal = parseRotationJournal(await object.json(), accountId);
    let action = rotationReconcileAction(this.getAccount(accountId).credentialVersion, journal);
    if (action === "apply") {
      const encryptionKey = await this.masterKey;
      await Promise.all([
        decryptSecret(encryptionKey, journal.accessTokenCiphertext),
        decryptSecret(encryptionKey, journal.refreshTokenCiphertext),
        decryptSecret(encryptionKey, journal.idTokenCiphertext)
      ]);
      // Decryption yielded, so re-read the authoritative version before the CAS.
      action = rotationReconcileAction(this.getAccount(accountId).credentialVersion, journal);
      if (action === "apply") {
        let applied = false;
        this.state.storage.transactionSync(() => {
          applied = this.sql
            .exec<{ id: string }>(
              `UPDATE accounts
                  SET access_token = ?, refresh_token = ?, id_token = ?, credential_version = ?,
                      state = 'ok', cooldown_until = '', last_refreshed_at = ?, updated_at = ?
                WHERE id = ? AND credential_version = ? RETURNING id`,
              journal.accessTokenCiphertext,
              journal.refreshTokenCiphertext,
              journal.idTokenCiphertext,
              journal.targetVersion,
              journal.createdAt,
              journal.createdAt,
              accountId,
              journal.baseVersion
            )
            .toArray().length === 1;
        });
        if (!applied) throw new Error("credential rotation reconciliation CAS failed");
      }
    }
    try {
      await this.env.ROTATION_JOURNAL.delete(key);
    } catch {
      console.warn("credential rotation journal cleanup is pending", accountId);
    }
  }

  private rotationKey(accountId: string): string {
    return `credential-rotation/${accountId}.json`;
  }

  private safeAccount(account: AccountRecord): Omit<AccountRecord, "accessTokenCiphertext" | "refreshTokenCiphertext" | "idTokenCiphertext"> {
    const { accessTokenCiphertext: _access, refreshTokenCiphertext: _refresh, idTokenCiphertext: _id, ...safe } = account;
    return safe;
  }
}
