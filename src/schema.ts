const migrations: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      id_token TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'unknown',
      credential_version INTEGER NOT NULL DEFAULT 1,
      last_refreshed_at TEXT NOT NULL,
      cooldown_until TEXT NOT NULL DEFAULT '',
      next_probe_at TEXT NOT NULL DEFAULT '',
      concurrency_cap INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      endpoints TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS policy_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      strategy TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (group_id, account_id),
      FOREIGN KEY (group_id) REFERENCES policy_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS endpoints (
      name TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES policy_groups(id) ON DELETE RESTRICT
    )`,
    `CREATE TABLE IF NOT EXISTS usage_current (
      account_id TEXT PRIMARY KEY,
      plan_type TEXT NOT NULL DEFAULT '',
      windows TEXT NOT NULL DEFAULT '[]',
      captured_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS turn_affinity (
      turn_state_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_turn_affinity_expires ON turn_affinity(expires_at)`
  ],
  [
    `ALTER TABLE api_keys ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1`
  ],
  [
    `ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]'`
  ],
  [
    `ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))`
  ]
];

export function migrateSchema(sql: SqlStorage): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const row = sql.exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").one();
  let current = Number(row.version);
  if (current > migrations.length) throw new Error(`database schema ${current} is newer than supported ${migrations.length}`);

  while (current < migrations.length) {
    const version = current + 1;
    for (const statement of migrations[version - 1]) sql.exec(statement);
    sql.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, new Date().toISOString());
    current = version;
  }
  return current;
}

export function currentSchemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").one();
  return Number(row.version);
}
