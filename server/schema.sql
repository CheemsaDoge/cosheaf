-- Cosheaf sidecar schema (Forgejo backend).

-- Cosheaf stores no passwords or sessions. Server-rendered pages receive an
-- opaque Cosheaf token as an HttpOnly `cosheaf_pat` cookie; API clients and
-- agents send the same Cosheaf-only credential as `Authorization: Bearer` or
-- Gitea/tea-style `Authorization: token`.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tokens;

-- Cached Cosheaf-issued Forgejo PATs. Forgejo only returns a PAT secret when
-- it is created, so reusing one across logins requires a local credential
-- cache. Login still validates the password with Forgejo before returning a
-- cached PAT.
CREATE TABLE IF NOT EXISTS login_tokens (
  username TEXT PRIMARY KEY,
  pat TEXT NOT NULL,
  token_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Scope set the cached PAT was minted with (sorted, comma-joined). When the
  -- scope set changes, a cached token whose `scopes` no longer matches is
  -- re-minted on next login instead of being served missing a new scope (#148).
  -- Existing rows are migrated to NULL in db.ts and re-mint on next login.
  scopes TEXT
);

-- Opaque Cosheaf API tokens handed to browsers, agents, and CLI clients.
-- The backing Forgejo PAT stays server-side so clients cannot use Cosheaf
-- credentials directly against Forgejo.
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  forgejo_pat TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Site-wide admin state. These rows are Cosheaf-local operator state, not
-- workspace knowledge: Forgejo owns repository membership, while Cosheaf owns
-- global toggles such as whether public registration is currently open.
CREATE TABLE IF NOT EXISTS site_admins (
  username TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS registration_invites (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_locks (
  workspace_slug TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);

-- No workspaces table. The workspace slug IS the Forgejo `owner/repo` full
-- name, the display name comes from the Forgejo repo description, and the
-- workspace markdown is Coflat. A `cosheaf-format-coflat` topic may mark repos
-- as Cosheaf/Coflat workspaces, but it no longer selects among Markdown modes.
-- Sidecar tables key off the slug directly (`workspace_slug TEXT` holding
-- `owner/repo`); legacy `workspace_id INTEGER` columns and bare-repo-name
-- slugs are migrated in db.ts around this schema run.

-- Memberships: removed. Role and access are sourced from Forgejo's
-- collaborator-permission API; middleware queries Forgejo and caches.

-- Page identity. Pages are the only document kind cosheaf indexes today;
-- additional kinds (if ever) get their own tables, not a polymorphic column.
CREATE TABLE IF NOT EXISTS doc_map (
  cosheaf_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  forgejo_id TEXT NOT NULL,  -- repo-relative path of the markdown file
  title TEXT,
  excerpt TEXT,
  fts_rowid INTEGER,
  status TEXT CHECK (status IN ('draft', 'proved', 'refuted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_slug, cosheaf_id),
  UNIQUE (workspace_slug, forgejo_id)
);

-- Pre-existing DBs may have legacy target_id / author_user_id columns and
-- idx_doc_map_target / idx_doc_map_type; both unused since the page-only refactor.
DROP INDEX IF EXISTS idx_doc_map_target;
DROP INDEX IF EXISTS idx_doc_map_type;

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  workspace_slug UNINDEXED,
  cosheaf_id UNINDEXED,
  path,
  title,
  body,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS backlinks (
  workspace_slug TEXT NOT NULL,
  src_id TEXT NOT NULL,
  src_path TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (workspace_slug, src_id, target_label)
);
CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (workspace_slug, target_id);

-- Derived cross-reference targets inside Coflat Markdown pages. These are
-- rebuildable from Coflat Markdown files and let page A resolve
-- `[@thm:...]` / `[@eq:...]` labels that are defined in page B.
CREATE TABLE IF NOT EXISTS xref_targets (
  workspace_slug TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('block', 'equation', 'heading')),
  display_label TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (workspace_slug, target_id, source_path)
);
CREATE INDEX IF NOT EXISTS idx_xref_targets_id ON xref_targets (workspace_slug, target_id);
CREATE INDEX IF NOT EXISTS idx_xref_targets_path ON xref_targets (workspace_slug, source_path);

-- Derived bibliography citation keys from BibTeX companion files. These are
-- rebuildable from Forgejo .bib files and let diagnostics distinguish paper
-- citations such as `[@knuth1984]` from missing page ids or Coflat labels.
CREATE TABLE IF NOT EXISTS citation_targets (
  workspace_slug TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  PRIMARY KEY (workspace_slug, target_id, source_path)
);
CREATE INDEX IF NOT EXISTS idx_citation_targets_id ON citation_targets (workspace_slug, target_id);
CREATE INDEX IF NOT EXISTS idx_citation_targets_path ON citation_targets (workspace_slug, source_path);

-- Same-file duplicate cross-reference ids cannot be represented by
-- xref_targets' unique row shape. Keep a rebuildable validation table so
-- `[@id]` never silently resolves when the source defines it twice.
CREATE TABLE IF NOT EXISTS xref_target_duplicates (
  workspace_slug TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (workspace_slug, target_id, source_path)
);
CREATE INDEX IF NOT EXISTS idx_xref_target_duplicates_id ON xref_target_duplicates (workspace_slug, target_id);

CREATE TABLE IF NOT EXISTS page_tags (
  workspace_slug TEXT NOT NULL,
  cosheaf_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (workspace_slug, cosheaf_id, tag)
);

-- Parsed cosheaf.yaml cached per branch (#182). Derived/rebuildable from
-- Forgejo (the file is authoritative); the webhook busts a row on a cosheaf.yaml
-- push and `workspace reindex` clears them, so the next render reloads. NOT
-- durable knowledge.
CREATE TABLE IF NOT EXISTS repo_config (
  workspace_slug TEXT NOT NULL,
  branch TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_slug, branch)
);

CREATE TABLE IF NOT EXISTS webhook_log (
  delivery_id TEXT PRIMARY KEY,
  delivered_at INTEGER NOT NULL,
  event_type TEXT NOT NULL
);

-- Optional advisory live-work leases for concurrent agents (#95). Pure local
-- coordination state — NOT ownership, durable knowledge, or server authority
-- over issue assignment, and with no Forgejo source; rows expire and are
-- disposable (analogous to webhook_log). They let multiple runners avoid
-- duplicating live work on the same issue; issues/PRs remain the only durable
-- state on Forgejo.
CREATE TABLE IF NOT EXISTS issue_claims (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  runner_name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  holder_username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_claims_active ON issue_claims(workspace_slug, issue_number, expires_at);

-- Branches and pull requests: removed. They live on Forgejo as their natural
-- representation. The server reads them on demand via the Forgejo client and
-- relies on push/PR/review webhooks only for cache invalidation (page
-- reindex on push; issue mirror on issue events). No SQLite workflow state.

-- There is no issues mirror: Forgejo's repo-scoped /issues already supports
-- the same filters and a mirror would drift on partial webhook deliveries.
