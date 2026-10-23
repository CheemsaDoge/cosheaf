import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { bootstrapSiteAdmins } from "./site-admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load .env.dev from the repo root or CWD if present, so CLI / dev
// invocations don't need `set -a; source ./.env.dev; set +a`. Uses Node's
// built-in process.loadEnvFile() (Node 21.7+). Existing process.env wins.
for (const candidate of [
  path.resolve(__dirname, "..", ".env.dev"),
  path.resolve(process.cwd(), ".env.dev"),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export interface Config {
  // "hosted" (default): Forgejo-backed multi-workspace server. "local": the
  // Cosheaf Workbench serving a single on-disk folder through a
  // LocalGitWorkspaceBackend, with no Forgejo, webhooks, or reconciler.
  mode: "hosted" | "local";
  dataDir: string;
  port: number;
  // Local Workbench only. The loopback bind address (default 127.0.0.1) and an
  // optional shared access token. With no token the Workbench stays a loopback,
  // no-auth single-user tool (today's behavior). A token gates every request so
  // the operator can safely expose the Workbench on a non-loopback `host` and
  // reach it from another device; how it is exposed (tunnel/proxy/VPN) and where
  // TLS terminates is the operator's responsibility. Both are inert in hosted
  // mode (which uses `port`/its own auth and binds via the launcher).
  host: string;
  accessToken: string | null;
  forgejoUrl: string;
  // Non-site-admin runtime token. This is the token name exposed in normal
  // app env and should not carry Forgejo site-admin privileges.
  forgejoToken: string;
  // Site-admin/provisioning token. Keep its usage limited to explicit
  // provisioning, webhook reconciliation, operator CLI paths, and the
  // open-registration route (gated by registrationOpen below, default-off).
  forgejoAdminToken: string;
  webhookSecret: string;
  webhookUrl: string;
  // Canonical browser origin for CSRF checks and secure-cookie detection. Set
  // COSHEAF_PUBLIC_ORIGIN behind a reverse proxy so these browser decisions do
  // not depend on client-controlled Forwarded headers.
  publicOrigin: string | null;
  // Web self-service signup. false (default) makes GET/POST /register 404;
  // true enables anonymous account creation through the admin token. Set via
  // COSHEAF_REGISTRATION_MODE=open. This is the only request-path consumer of
  // forgejoAdminToken, so it stays off unless explicitly enabled.
  registrationOpen: boolean;
  // Number of trusted reverse-proxy hops in front of cosheaf. Used to pick the
  // real client IP out of X-Forwarded-For for registration rate limiting and to
  // trust the matching X-Forwarded-Proto/Host hop for CSRF origin checks and
  // secure-cookie detection. 0 (default) trusts no proxy
  // (dev / direct) and the limiter falls back to a single shared bucket; behind
  // the lab's single Caddy set COSHEAF_TRUSTED_PROXY_HOPS=1.
  trustedProxyHops: number;
  // Coverify chat-reply shell-out. The bot account is distinct from the human
  // user; coverify authenticates to the Cosheaf API with its own token and
  // posts the reply itself. An empty token disables the chat launcher/reply path.
  coverifyCmd: string;
  coverifyApiUrl: string;
  coverifyBotToken: string;
  coverifyBotLogin: string;
  reconcileIntervalMs: number;
}

function required(name: string): string {
  const v = optionalEnvValue(process.env[name]);
  if (!v) {
    console.error(
      `missing required env var: ${name}\n` +
        "  Did you copy .env.example to .env.dev and load it?\n" +
        "  cosheaf auto-loads .env.dev from the repo root or current working directory.",
    );
    process.exit(1);
  }
  return v;
}

function withDefault(name: string, fallback: string): string {
  return optionalEnvValue(process.env[name]) ?? fallback;
}

function optionalEnvValue(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

export function normalizeOptionalOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("expected http or https URL");
  }
  return url.origin;
}

function optionalOrigin(name: string): string | null {
  try {
    return normalizeOptionalOrigin(process.env[name]);
  } catch (_err) {
    console.error(`invalid ${name}: expected an absolute http(s) URL origin`);
    process.exit(1);
  }
}

export function parseTrustedProxyHops(raw: string | undefined): number {
  const value = optionalEnvValue(raw);
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error("expected a non-negative integer");
  }
  return Number(value);
}

export function parsePort(raw: string | undefined, fallback: number): number {
  const value = optionalEnvValue(raw);
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error("expected an integer TCP port");
  }
  const port = Number(value);
  if (port > 65535) throw new Error("expected an integer TCP port");
  return port;
}

// True for an address that is only reachable from the same machine. Used to
// decide whether the Workbench may bind without an access token: loopback is
// safe auth-free, anything else needs COSHEAF_WORKBENCH_TOKEN.
export function isLoopbackHost(host: string): boolean {
  // Strip surrounding brackets so "[::1]" normalizes to "::1". Matches the whole
  // 127.0.0.0/8 loopback block (not just 127.0.0.1 — 127.0.0.2 etc. are valid
  // loopback aliases) and IPv4-mapped loopback. Stays strict in the dangerous
  // direction: never matches a non-loopback address.
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

// Refuse to expose the local Workbench beyond loopback without an access token.
// A non-loopback bind makes the ambient local-file authority reachable from the
// network, so it must be gated. Returns an error message to print + exit on, or
// null when the (host, token) combination is safe to serve. Pure for tests.
export function refuseRemoteWithoutToken(host: string, token: string | null): string | null {
  if (isLoopbackHost(host) || token) return null;
  return (
    `refusing to bind the Workbench on ${host} without an access token.\n` +
    `  A non-loopback bind is reachable from the network and would expose local\n` +
    `  file read/write with no authentication. Set COSHEAF_WORKBENCH_TOKEN to a\n` +
    `  secret first (clients send it as 'Authorization: Bearer <token>' or via the\n` +
    `  /login page). Exposing the port and terminating TLS is up to you.`
  );
}

export function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  const value = optionalEnvValue(raw);
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error("expected a non-negative integer");
  }
  return Number(value);
}

function trustedProxyHops(): number {
  try {
    return parseTrustedProxyHops(process.env.COSHEAF_TRUSTED_PROXY_HOPS);
  } catch (_err) {
    console.error("invalid COSHEAF_TRUSTED_PROXY_HOPS: expected a non-negative integer");
    process.exit(1);
  }
}

function serverPort(): number {
  try {
    return parsePort(process.env.COSHEAF_PORT, 3030);
  } catch (_err) {
    console.error("invalid COSHEAF_PORT: expected an integer TCP port");
    process.exit(1);
  }
}

function reconcileIntervalMs(): number {
  try {
    return parseNonNegativeInteger(process.env.COSHEAF_RECONCILE_INTERVAL_MS, 0);
  } catch (_err) {
    console.error("invalid COSHEAF_RECONCILE_INTERVAL_MS: expected a non-negative integer");
    process.exit(1);
  }
}

export function validateTrustedProxyOrigin(publicOrigin: string | null, trustedProxyHops: number): void {
  if (trustedProxyHops > 0 && !publicOrigin) {
    throw new Error("COSHEAF_PUBLIC_ORIGIN is required when COSHEAF_TRUSTED_PROXY_HOPS is greater than 0");
  }
}

export function loadConfig(): Config {
  const dataDir = withDefault("COSHEAF_DATA_DIR", path.resolve(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });
  const forgejoUrl = withDefault("COSHEAF_FORGEJO_URL", "http://127.0.0.1:3002");
  const publicOrigin = optionalOrigin("COSHEAF_PUBLIC_ORIGIN");
  const proxyHops = trustedProxyHops();
  try {
    validateTrustedProxyOrigin(publicOrigin, proxyHops);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  return {
    mode: "hosted",
    dataDir,
    port: serverPort(),
    host: "127.0.0.1",
    accessToken: null,
    forgejoUrl,
    forgejoToken: required("COSHEAF_FORGEJO_TOKEN"),
    forgejoAdminToken: required("COSHEAF_FORGEJO_ADMIN_TOKEN"),
    webhookSecret: required("COSHEAF_WEBHOOK_SECRET"),
    webhookUrl: withDefault("COSHEAF_WEBHOOK_URL", "http://127.0.0.1:3030/api/v1/webhooks/forgejo"),
    publicOrigin,
    registrationOpen: withDefault("COSHEAF_REGISTRATION_MODE", "off") === "open",
    trustedProxyHops: proxyHops,
    coverifyCmd: withDefault("COSHEAF_COVERIFY_CMD", "coverify"),
    coverifyApiUrl: withDefault("COSHEAF_COVERIFY_API_URL", "http://127.0.0.1:3030/api/v1"),
    coverifyBotToken: withDefault("COSHEAF_COVERIFY_BOT_TOKEN", ""),
    coverifyBotLogin: withDefault("COSHEAF_COVERIFY_BOT_LOGIN", "coverify"),
    reconcileIntervalMs: reconcileIntervalMs(),
  };
}

// Build a Config for the local Workbench (config.mode === "local"). The backend
// is a LocalGitWorkspaceBackend, so the Forgejo fields are inert placeholders
// (never read in local mode). Kept here, outside server/local/**, so the
// Workbench source never even names a forge field (enforced by
// scripts/check-no-forgejo-in-workbench.mjs).
export function buildLocalConfig(opts: {
  dataDir: string;
  port: number;
  host?: string;
  accessToken?: string | null;
  // The public origin the browser sees (e.g. https://wb.example) when the
  // Workbench is fronted by a TLS-terminating proxy. Without it, same-origin
  // CSRF checks and the cookie Secure flag derive from the internal plain-http
  // request and reject https writes — set it when exposing behind an https proxy.
  publicOrigin?: string | null;
}): Config {
  mkdirSync(opts.dataDir, { recursive: true });
  // The sidecar lives inside the user's workspace folder; keep git from ever
  // staging it (the commit page's `git add -A` would otherwise commit and push
  // the live SQLite db). A self-ignoring .gitignore inside the dir is enough.
  writeFileSync(path.join(opts.dataDir, ".gitignore"), "*\n");
  return {
    mode: "local",
    dataDir: opts.dataDir,
    port: opts.port,
    host: opts.host ?? "127.0.0.1",
    accessToken: opts.accessToken ?? null,
    forgejoUrl: "http://127.0.0.1:0",
    forgejoToken: "",
    forgejoAdminToken: "",
    webhookSecret: "",
    webhookUrl: "",
    publicOrigin: opts.publicOrigin ?? null,
    registrationOpen: false,
    trustedProxyHops: 0,
    coverifyCmd: "",
    coverifyApiUrl: "",
    coverifyBotToken: "",
    coverifyBotLogin: "",
    reconcileIntervalMs: 0,
  };
}

let dbInstance: Database.Database | null = null;

// Legacy sidecar tables keyed off `workspace_id INTEGER` (FK into the old
// `workspaces` table) get rewritten to key off `workspace_slug TEXT`. We
// detect the legacy shape and migrate in place, preserving rows by joining
// through the workspaces table while it still exists, then drop it.
//
// Older migrations (doc_type/forgejo_kind column drop, issues sidecar drop,
// backlinks.line add) were retired — every live cosheaf DB has long since
// run them. If you're hitting a fresh-import error from a pre-May-17 DB,
// the recovery is `rm $COSHEAF_DATA_DIR/db.sqlite && pnpm setup:dev`; the
// sidecar is rebuildable from Forgejo.
function migrateDropWorkspacesTable(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const has = (name: string): boolean => tables.some((t) => t.name === name);
  if (!has("workspaces")) return; // already migrated

  const colHas = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === col);

  db.exec("BEGIN");
  try {
    if (has("doc_map") && colHas("doc_map", "workspace_id")) {
      db.exec(`
        CREATE TABLE doc_map_new (
          cosheaf_id TEXT NOT NULL,
          workspace_slug TEXT NOT NULL,
          forgejo_id TEXT NOT NULL,
          title TEXT,
          excerpt TEXT,
          fts_rowid INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_slug, cosheaf_id),
          UNIQUE (workspace_slug, forgejo_id)
        );
        INSERT INTO doc_map_new (cosheaf_id, workspace_slug, forgejo_id, title, excerpt, fts_rowid, created_at)
          SELECT d.cosheaf_id, w.slug, d.forgejo_id, d.title, NULL, NULL, d.created_at
          FROM doc_map d JOIN workspaces w ON w.id = d.workspace_id;
        DROP TABLE doc_map;
        ALTER TABLE doc_map_new RENAME TO doc_map;
      `);
    }
    if (has("backlinks") && colHas("backlinks", "workspace_id")) {
      db.exec(`
        CREATE TABLE backlinks_new (
          workspace_slug TEXT NOT NULL,
          src_id TEXT NOT NULL,
          src_path TEXT NOT NULL,
          target_id TEXT,
          target_label TEXT NOT NULL,
          line INTEGER,
          PRIMARY KEY (workspace_slug, src_id, target_label)
        );
        INSERT INTO backlinks_new (workspace_slug, src_id, src_path, target_id, target_label, line)
          SELECT w.slug, b.src_id, b.src_path, b.target_id, b.target_label, b.line
          FROM backlinks b JOIN workspaces w ON w.id = b.workspace_id;
        DROP TABLE backlinks;
        ALTER TABLE backlinks_new RENAME TO backlinks;
        CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (workspace_slug, target_id);
      `);
    }
    if (has("page_tags") && colHas("page_tags", "workspace_id")) {
      db.exec(`
        CREATE TABLE page_tags_new (
          workspace_slug TEXT NOT NULL,
          cosheaf_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (workspace_slug, cosheaf_id, tag)
        );
        INSERT INTO page_tags_new (workspace_slug, cosheaf_id, tag)
          SELECT w.slug, p.cosheaf_id, p.tag
          FROM page_tags p JOIN workspaces w ON w.id = p.workspace_id;
        DROP TABLE page_tags;
        ALTER TABLE page_tags_new RENAME TO page_tags;
      `);
    }
    if (has("notes_fts")) {
      // FTS5 virtual tables can't be ALTERed; rebuild with the new column
      // shape. Body is rebuildable via `pnpm cli workspace reindex <slug>`
      // (which is the recommended post-migration step), so we don't try to
      // preserve content here — joining FTS rows to workspaces and rewriting
      // them would be fragile and slow.
      db.exec(`
        DROP TABLE notes_fts;
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          workspace_slug UNINDEXED,
          cosheaf_id UNINDEXED,
          path,
          title,
          body,
          tokenize='trigram'
        );
      `);
    }
    db.exec("DROP TABLE workspaces;");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// #148: login_tokens gained a `scopes` column recording the scope set a cached
// PAT was minted with. schema.sql's CREATE IF NOT EXISTS won't add the column
// to an existing table, so add it here. Pre-existing rows get NULL, which never
// matches the current scope signature — so the auth flow re-mints them on the
// next login, self-healing a scope-set change rather than serving a stale token
// that lacks a newly-added scope.
function migrateAddLoginTokenScopes(db: Database.Database): void {
  const hasScopes = (db.prepare("PRAGMA table_info(login_tokens)").all() as Array<{ name: string }>)
    .some((col) => col.name === "scopes");
  if (!hasScopes) db.exec("ALTER TABLE login_tokens ADD COLUMN scopes TEXT");
}

function migrateAddDocMapStatus(db: Database.Database): void {
  const hasStatus = (db.prepare("PRAGMA table_info(doc_map)").all() as Array<{ name: string }>)
    .some((col) => col.name === "status");
  if (!hasStatus) {
    db.exec("ALTER TABLE doc_map ADD COLUMN status TEXT");
  }
}

function collapseExcerpt(body: string | null, maxLength = 220): string | null {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

// #368/#371: existing sidecars predate doc_map.excerpt and doc_map.fts_rowid.
// Add the columns and populate them once from notes_fts so future deletes can
// key by rowid and the repo landing page never scans FTS bodies.
function migrateAddDocMapExcerptAndFtsRowid(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(doc_map)").all() as Array<{ name: string }>;
  const hasCol = (name: string): boolean => cols.some((col) => col.name === name);
  if (!hasCol("excerpt")) db.exec("ALTER TABLE doc_map ADD COLUMN excerpt TEXT");
  if (!hasCol("fts_rowid")) db.exec("ALTER TABLE doc_map ADD COLUMN fts_rowid INTEGER");
  const hasNotesFts = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'")
    .get();
  if (!hasNotesFts) return;
  const rows = db
    .prepare("SELECT rowid AS rowid, workspace_slug, cosheaf_id, body FROM notes_fts")
    .all() as Array<{ rowid: number; workspace_slug: string; cosheaf_id: string; body: string | null }>;
  const update = db.prepare("UPDATE doc_map SET fts_rowid = ?, excerpt = COALESCE(excerpt, ?) WHERE workspace_slug = ? AND cosheaf_id = ?");
  const tx = db.transaction(() => {
    for (const row of rows) update.run(row.rowid, collapseExcerpt(row.body), row.workspace_slug, row.cosheaf_id);
  });
  tx();
}

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Pre-schema migration: rewrite legacy `workspace_id INTEGER` tables to
  // `workspace_slug TEXT` before schema.sql's CREATE IF NOT EXISTS would
  // silently leave them in place.
  migrateDropWorkspacesTable(db);
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  bootstrapSiteAdmins(db);
  migrateAddDocMapExcerptAndFtsRowid(db);
  migrateAddLoginTokenScopes(db);
  migrateAddDocMapStatus(db);
  dbInstance = db;
  return db;
}
