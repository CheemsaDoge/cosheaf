// Sidecar maintenance. Forgejo is the source of truth; we mirror only what we
// need for fast read paths (FTS, backlinks, tags) and for keeping cosheaf doc
// ids stable across rebuilds.

import { resolveMarkdownReferencePathFromDocument } from "@chaoxu/coflat/parse";
import type Database from "better-sqlite3";
import { normalizeTheoremStatus } from "../shared/theorem-status.js";
import { extractBibTeXCitationKeys } from "./citations.js";
import { coflatMarkdownFormat } from "./document-format/coflat.js";
import type { DocumentLink, ParsedDocument } from "./document-format/types.js";
import { generateDocId } from "./ids.js";

export interface PageIngest {
  workspaceSlug: string;
  filePath: string;
  bodyText: string; // raw file content (frontmatter + body)
  // Existing path being canonically replaced by this write. Used by typed
  // branch-only renames so a stable page id can move paths without being treated
  // as a duplicate of itself.
  replacePath?: string;
}

export interface IngestPlan {
  cosheafId: string;
  title: string | null;
  rewrittenContent: string | null; // non-null if frontmatter needed an injected id
  commit: () => void; // commits sidecar transaction; call only after the canonical write succeeds
  commitBacklinksOnly: () => void; // second-pass link resolution after all ids/xrefs are visible
}

// Prepared-statement cache. `better-sqlite3` does not cache by SQL string, so
// without this we'd re-parse the same ~10 statements on every indexed page
// (hot during bulk reindex and webhook bursts).
const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function prep(db: Database.Database, sql: string): Database.Statement {
  let bySql = stmtCache.get(db);
  if (!bySql) {
    bySql = new Map();
    stmtCache.set(db, bySql);
  }
  let s = bySql.get(sql);
  if (!s) {
    s = db.prepare(sql);
    bySql.set(sql, s);
  }
  return s;
}

function pageExcerpt(body: string, maxLength = 220): string | null {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

function deleteFtsRow(db: Database.Database, workspaceSlug: string, cosheafId: string, ftsRowid?: number | null): void {
  if (typeof ftsRowid === "number") {
    prep(db, "DELETE FROM notes_fts WHERE rowid = ?").run(ftsRowid);
    return;
  }
  prep(db, "DELETE FROM notes_fts WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
}

function replaceBacklinks(
  db: Database.Database,
  workspaceSlug: string,
  cosheafId: string,
  filePath: string,
  bodyText: string,
  links: readonly DocumentLink[],
): void {
  prep(db, "DELETE FROM backlinks WHERE workspace_slug = ? AND src_id = ?")
    .run(workspaceSlug, cosheafId);
  const insertBacklink = prep(
    db,
    "INSERT OR IGNORE INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const link of links) {
    const targetId = resolveLinkTarget(db, workspaceSlug, filePath, link);
    insertBacklink.run(
      workspaceSlug,
      cosheafId,
      filePath,
      targetId,
      link.raw,
      link.line ?? lineFromOffset(bodyText, link.from),
    );
  }
}

export function planIndexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const format = coflatMarkdownFormat;
  const parsed = format.parseDocument(p.bodyText);
  const links = format.extractLinks(p.bodyText);
  const fmId = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.length > 0
    ? parsed.frontmatter.id
    : null;

  const existingByPath = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(p.workspaceSlug, p.filePath) as { cosheaf_id: string } | undefined;

  let cosheafId = fmId ?? existingByPath?.cosheaf_id ?? generateDocId();

  const collision = prep(
    db,
    `SELECT forgejo_id FROM doc_map
      WHERE workspace_slug = ?
        AND cosheaf_id = ?
        AND forgejo_id != ?
        AND (? IS NULL OR forgejo_id != ?)`,
  ).get(p.workspaceSlug, cosheafId, p.filePath, p.replacePath ?? null, p.replacePath ?? null) as { forgejo_id: string } | undefined;
  if (collision) {
    // A frontmatter id duplicated across files collides. Prefer this path's
    // already-assigned id (stable across reindexes) so we don't churn a fresh
    // random id every run — mint one only when there's no prior id, or the
    // prior id is itself the colliding value.
    cosheafId =
      existingByPath && existingByPath.cosheaf_id !== cosheafId ? existingByPath.cosheaf_id : generateDocId();
  }

  const explicitTitle =
    typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.length > 0
      ? parsed.frontmatter.title
      : null;
  const title = explicitTitle ?? format.extractTitle(parsed.body);
  const excerpt = pageExcerpt(parsed.body);
  const status = normalizeTheoremStatus(parsed.frontmatter.status);

  const commitBacklinksOnly = db.transaction(() => {
    replaceBacklinks(db, p.workspaceSlug, cosheafId, p.filePath, p.bodyText, links);
  });

  const commit = db.transaction(() => {
    const stalePath = prep(
      db,
      "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ? AND cosheaf_id != ?",
    ).get(p.workspaceSlug, p.filePath, cosheafId) as { cosheaf_id: string } | undefined;
    if (stalePath) {
      deletePageRows(db, p.workspaceSlug, stalePath.cosheaf_id);
    }

    const exists = prep(db, "SELECT 1 FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
      .get(p.workspaceSlug, cosheafId);
    const existingDoc = prep(db, "SELECT fts_rowid FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
      .get(p.workspaceSlug, cosheafId) as { fts_rowid: number | null } | undefined;
    deleteFtsRow(db, p.workspaceSlug, cosheafId, existingDoc?.fts_rowid ?? null);
    if (exists) {
      prep(db, "UPDATE doc_map SET forgejo_id = ?, title = ?, excerpt = ?, status = ? WHERE workspace_slug = ? AND cosheaf_id = ?")
        .run(p.filePath, title, excerpt, status, p.workspaceSlug, cosheafId);
    } else {
      prep(
        db,
        "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, excerpt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(cosheafId, p.workspaceSlug, p.filePath, title, excerpt, status, Date.now());
    }
    const ftsInsert = prep(
      db,
      "INSERT INTO notes_fts (workspace_slug, cosheaf_id, path, title, body) VALUES (?, ?, ?, ?, ?)",
    ).run(p.workspaceSlug, cosheafId, p.filePath, title ?? "", parsed.body);
    prep(db, "UPDATE doc_map SET fts_rowid = ? WHERE workspace_slug = ? AND cosheaf_id = ?")
      .run(ftsInsert.lastInsertRowid, p.workspaceSlug, cosheafId);
    prep(db, "DELETE FROM xref_targets WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    prep(db, "DELETE FROM xref_target_duplicates WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    const insertXrefTarget = prep(
      db,
      "INSERT OR IGNORE INTO xref_targets (workspace_slug, target_id, source_path, kind, display_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const xrefTargets = format.extractXrefTargets?.(p.bodyText) ?? [];
    const duplicateCounts = new Map<string, number>();
    for (const target of xrefTargets) duplicateCounts.set(target.id, (duplicateCounts.get(target.id) ?? 0) + 1);
    const insertXrefDuplicate = prep(
      db,
      "INSERT OR REPLACE INTO xref_target_duplicates (workspace_slug, target_id, source_path, count) VALUES (?, ?, ?, ?)",
    );
    for (const [targetId, count] of duplicateCounts) {
      if (count > 1) insertXrefDuplicate.run(p.workspaceSlug, targetId, p.filePath, count);
    }
    for (const target of xrefTargets) {
      insertXrefTarget.run(
        p.workspaceSlug,
        target.id,
        p.filePath,
        target.kind,
        target.label,
        target.line,
      );
    }
    replaceBacklinks(db, p.workspaceSlug, cosheafId, p.filePath, p.bodyText, links);
    prep(db, "DELETE FROM page_tags WHERE workspace_slug = ? AND cosheaf_id = ?")
      .run(p.workspaceSlug, cosheafId);
    const tags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
    const insertTag = prep(
      db,
      "INSERT OR IGNORE INTO page_tags (workspace_slug, cosheaf_id, tag) VALUES (?, ?, ?)",
    );
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0) {
        insertTag.run(p.workspaceSlug, cosheafId, t);
      }
    }
  });

  let rewritten: string | null = null;
  if (fmId !== cosheafId && !hasUnparsedDelimitedFrontmatter(p.bodyText, parsed.hadFrontmatter)) {
    rewritten = rewriteFrontmatterIdInPlace(p.bodyText, parsed, cosheafId);
    if (rewritten === null) {
      const newFm = { ...parsed.frontmatter, id: cosheafId };
      if (title) newFm.title = title;
      rewritten = format.serializeDocument(newFm, parsed.body);
    }
  }

  return { cosheafId, title, rewrittenContent: rewritten, commit, commitBacklinksOnly };
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function hasUnparsedDelimitedFrontmatter(source: string, hadParsedFrontmatter: boolean): boolean {
  if (hadParsedFrontmatter) return false;
  const firstEnd = frontmatterFenceLineEnd(source, 0);
  if (firstEnd === null) return false;
  let lineStart = firstEnd;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") return true;
    lineStart = lineEnd === -1 ? source.length : lineEnd + 1;
  }
  return false;
}

function rewriteFrontmatterIdInPlace(source: string, parsed: ParsedDocument, cosheafId: string): string | null {
  if (!parsed.hadFrontmatter) return null;
  const openingEnd = frontmatterFenceLineEnd(source, 0);
  if (openingEnd === null) return null;
  const closing = frontmatterClosingFence(source, openingEnd);
  if (!closing) return null;
  const lineEnding = source.slice(Math.max(0, openingEnd - 2), openingEnd) === "\r\n" ? "\r\n" : "\n";
  const idLine = findPlainTopLevelIdLine(source, openingEnd, closing.yamlEnd);
  if (idLine) {
    return `${source.slice(0, idLine.from)}id: ${cosheafId}${source.slice(idLine.to)}`;
  }
  return `${source.slice(0, openingEnd)}id: ${cosheafId}${lineEnding}${source.slice(openingEnd)}`;
}

function frontmatterClosingFence(source: string, bodyStart: number): { yamlEnd: number; bodyStart: number } | null {
  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      return {
        yamlEnd: rawLine.endsWith("\r") ? end - 1 : end,
        bodyStart: lineEnd === -1 ? source.length : lineEnd + 1,
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function findPlainTopLevelIdLine(source: string, start: number, end: number): { from: number; to: number } | null {
  let lineStart = start;
  while (lineStart <= end) {
    const lineEnd = source.indexOf("\n", lineStart);
    const rawEnd = lineEnd === -1 ? source.length : lineEnd;
    const boundedRawEnd = Math.min(rawEnd, end);
    const textEnd = source[boundedRawEnd - 1] === "\r" ? boundedRawEnd - 1 : boundedRawEnd;
    const line = source.slice(lineStart, textEnd);
    if (line.startsWith("id:") || line.startsWith("id :")) {
      return { from: lineStart, to: textEnd };
    }
    if (lineEnd === -1 || lineEnd >= end) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function frontmatterFenceLineEnd(source: string, offset: number): number | null {
  if (!source.startsWith("---", offset)) return null;
  const afterFence = offset + 3;
  const next = source[afterFence];
  if (next === "\n") return afterFence + 1;
  if (next === "\r" && source[afterFence + 1] === "\n") return afterFence + 2;
  return afterFence === source.length ? afterFence : null;
}

// Convenience for webhook-driven reindex where there's no Forgejo write to fail.
export function indexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const plan = planIndexPage(db, p);
  plan.commit();
  return plan;
}

// Index a batch of already-fetched page bodies. The two-pass ordering invariant
// lives here so every batch caller (full-tree reindex and incremental push)
// shares it: build every page's plan and commit it FIRST, making all doc ids
// and xref targets visible, THEN — only when the batch has more than one page —
// run a backlinks-only second pass so cross-file `[@...]` links resolve against
// the ids/targets the first pass just wrote (without reparsing or rewriting the
// FTS/doc rows). A single-page batch needs no second pass; its own commit
// already wrote its backlinks. Callers pre-filter fetch failures — every body
// passed here is committed. Returns the committed paths in input order.
export function indexPageBatch(
  db: Database.Database,
  workspaceSlug: string,
  bodies: readonly { path: string; body: string }[],
): string[] {
  const plans = bodies.map(({ path, body }) => ({
    path,
    plan: planIndexPage(db, { workspaceSlug, filePath: path, bodyText: body }),
  }));
  for (const { plan } of plans) plan.commit();
  if (plans.length > 1) {
    for (const { plan } of plans) plan.commitBacklinksOnly();
  }
  return plans.map((p) => p.path);
}

// Index a batch of already-fetched `.bib` bodies. A thin loop over
// indexCitationFile, kept beside indexPageBatch so both reindex callers share
// one batch shape. Callers pre-filter fetch failures. Returns the paths in
// input order.
export function indexCitationBatch(
  db: Database.Database,
  workspaceSlug: string,
  bodies: readonly { path: string; body: string }[],
): string[] {
  for (const { path, body } of bodies) {
    indexCitationFile(db, { workspaceSlug, filePath: path, bodyText: body });
  }
  return bodies.map((b) => b.path);
}

function deletePageRows(db: Database.Database, workspaceSlug: string, cosheafId: string): void {
  const doc = prep(db, "SELECT fts_rowid FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
    .get(workspaceSlug, cosheafId) as { fts_rowid: number | null } | undefined;
  deleteFtsRow(db, workspaceSlug, cosheafId, doc?.fts_rowid ?? null);
  prep(db, "DELETE FROM backlinks WHERE workspace_slug = ? AND src_id = ?").run(workspaceSlug, cosheafId);
  prep(db, "DELETE FROM page_tags WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
  prep(db, "DELETE FROM xref_targets WHERE workspace_slug = ? AND source_path IN (SELECT forgejo_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?)")
    .run(workspaceSlug, workspaceSlug, cosheafId);
  prep(db, "DELETE FROM xref_target_duplicates WHERE workspace_slug = ? AND source_path IN (SELECT forgejo_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?)")
    .run(workspaceSlug, workspaceSlug, cosheafId);
  prep(db, "DELETE FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
}

export function deletePage(db: Database.Database, workspaceSlug: string, filePath: string): void {
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(workspaceSlug, filePath) as { cosheaf_id: string } | undefined;
  if (!row) return;
  db.transaction(() => deletePageRows(db, workspaceSlug, row.cosheaf_id))();
}

// Local Workbench keeps the sidecar live itself: the working tree is canonical
// and there is no merge webhook, so a write/delete must be indexed immediately.
// Both are a no-op in hosted mode, where webhooks/reindex reconcile `main`.
// Centralized here so every write/delete route doesn't repeat the rationale.
export function indexLocalWrite(
  local: boolean,
  db: Database.Database,
  workspaceSlug: string,
  plan: IngestPlan | null,
  renamedFrom?: string,
): void {
  if (!local) return;
  plan?.commit();
  if (renamedFrom) deletePage(db, workspaceSlug, renamedFrom);
}

export function indexLocalDelete(local: boolean, db: Database.Database, workspaceSlug: string, filePath: string): void {
  if (local) deletePage(db, workspaceSlug, filePath);
}

export function indexCitationFile(
  db: Database.Database,
  p: { workspaceSlug: string; filePath: string; bodyText: string },
): number {
  const keys = extractBibTeXCitationKeys(p.bodyText);
  db.transaction(() => {
    prep(db, "DELETE FROM citation_targets WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    const insertCitation = prep(
      db,
      "INSERT OR IGNORE INTO citation_targets (workspace_slug, target_id, source_path) VALUES (?, ?, ?)",
    );
    for (const key of keys) insertCitation.run(p.workspaceSlug, key, p.filePath);
  })();
  return keys.length;
}

export function deleteCitationFile(db: Database.Database, workspaceSlug: string, filePath: string): void {
  prep(db, "DELETE FROM citation_targets WHERE workspace_slug = ? AND source_path = ?")
    .run(workspaceSlug, filePath);
}

export function pruneWorkspaceIndex(
  db: Database.Database,
  workspaceSlug: string,
  seenMarkdown: Set<string>,
  seenCitations: Set<string>,
): void {
  const indexedPages = db
    .prepare("SELECT forgejo_id FROM doc_map WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ forgejo_id: string }>;
  for (const row of indexedPages) {
    if (!seenMarkdown.has(row.forgejo_id)) deletePage(db, workspaceSlug, row.forgejo_id);
  }
  const indexedCitations = db
    .prepare("SELECT source_path FROM citation_targets WHERE workspace_slug = ? GROUP BY source_path")
    .all(workspaceSlug) as Array<{ source_path: string }>;
  for (const row of indexedCitations) {
    if (!seenCitations.has(row.source_path)) deleteCitationFile(db, workspaceSlug, row.source_path);
  }
}

function resolveLinkTarget(
  db: Database.Database,
  workspaceSlug: string,
  srcPath: string,
  link: DocumentLink,
): string | null {
  if (link.kind === "id") {
    const row = prep(db, "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
      .get(workspaceSlug, link.ref) as { cosheaf_id: string } | undefined;
    if (row) return row.cosheaf_id;
    const target = prep(db, "SELECT target_id FROM xref_targets WHERE workspace_slug = ? AND target_id = ? LIMIT 1")
      .get(workspaceSlug, link.ref) as { target_id: string } | undefined;
    const duplicate = prep(db, "SELECT 1 FROM xref_target_duplicates WHERE workspace_slug = ? AND target_id = ? LIMIT 1")
      .get(workspaceSlug, link.ref);
    if (duplicate) return link.ref;
    return target?.target_id ?? link.ref;
  }
  const [linkPath] = link.ref.split("#", 1);
  if (!linkPath) return null;
  const resolved = resolveMarkdownReferencePathFromDocument(srcPath, linkPath);
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(workspaceSlug, resolved) as { cosheaf_id: string } | undefined;
  return row?.cosheaf_id ?? null;
}
