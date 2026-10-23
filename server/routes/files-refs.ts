// Read surface split out of routes/files.ts: xref/suggest/search/tags/backlinks/
// validation. Registered onto the same `files` Hono app via registerFileRefRoutes
// so route paths are identical. Owns the branch-ref cache; the write path in
// files.ts imports invalidateBranchRefs to keep the cache consistent.

import {
  extractFirstH1 as extractCoflatFirstH1,
  parseFrontmatter as parseCoflatFrontmatter,
} from "@chaoxu/coflat/parse";
import type { Hono } from "hono";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import type { WorkspaceValidation } from "../../shared/validation.js";
import {
  resolveWorkspaceCrossrefs,
  searchWorkspacePages,
  workspaceBacklinks,
  workspacePageRefMatches,
  workspacePagesByTag,
  workspaceTagCloud,
  workspaceTagSuggestions,
  workspaceXrefMatches,
} from "../page-search.js";
import { getCachedTree, setCachedTree } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { ensureWorkspaceStatusesBackfilled, workspaceValidation } from "../workspace-validation.js";
import { safeRel, validRequestedBranch } from "./files.js";
import { parseBoundedPositiveInt } from "./query-params.js";
import { bad } from "./responses.js";

interface RefSuggestion {
  id: string;
  insert: string;
  display: string;
}

interface BranchRefEntry {
  id: string;
  title: string | null;
  path: string;
  kind: "page" | "block" | "equation" | "heading";
  line: number | null;
}

const BRANCH_REF_CACHE_MAX = 128;
const BRANCH_REF_CACHE_TTL_MS = 5 * 60_000;
const branchRefCache = new Map<string, { expiresAt: number; entries: readonly BranchRefEntry[] }>();

function branchRefCacheKey(owner: string, repo: string, branch: string, tree: readonly { path: string; sha?: string; size?: number }[]): string {
  return `${owner}|${repo}|${branch}|${tree.map((entry) => `${entry.path}:${entry.sha ?? ""}:${entry.size ?? ""}`).join("\n")}`;
}

function getCachedBranchRefs(key: string): readonly BranchRefEntry[] | null {
  const cached = branchRefCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    branchRefCache.delete(key);
    return null;
  }
  return cached.entries;
}

function setCachedBranchRefs(key: string, entries: readonly BranchRefEntry[]): void {
  if (branchRefCache.size >= BRANCH_REF_CACHE_MAX) {
    const first = branchRefCache.keys().next().value;
    if (first) branchRefCache.delete(first);
  }
  branchRefCache.set(key, { expiresAt: Date.now() + BRANCH_REF_CACHE_TTL_MS, entries });
}

export function invalidateBranchRefs(owner: string, repo: string, branch: string): void {
  const prefix = `${owner}|${repo}|${branch}|`;
  for (const key of branchRefCache.keys()) {
    if (key.startsWith(prefix)) branchRefCache.delete(key);
  }
}

export function _clearBranchRefCacheForTests(): void {
  branchRefCache.clear();
}

export function registerFileRefRoutes(files: Hono<AppEnv>): void {
  files.get("/:owner/:repo/suggest", async (c) => {
    const prefix = c.req.query("prefix")?.trim() ?? "";
    const trigger = c.req.query("trigger") ?? "[@";
    const limit = parseBoundedPositiveInt(c.req.query("limit"), 10, 20);
    const ws = c.get("workspace");
    const branch = c.req.query("branch")?.trim() || "main";
    if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
    // `#` trigger completes frontmatter tags from the page_tags index (#388),
    // ranked by frequency. Tags are main-only, so branch is irrelevant here.
    if (trigger === "#") {
      const tagRows = workspaceTagSuggestions(c.get("db"), ws.slug, prefix, limit);
      return c.json({
        suggestions: tagRows.map((r): RefSuggestion => ({ id: r.tag, insert: `#${r.tag}`, display: `${r.tag} (${r.count})` })),
      });
    }
    // For `[@` trigger we suggest from doc_map (cross-ref ids + titles).
    if (trigger !== "[@") return c.json({ suggestions: [] });
    // #390: the caller passes the current document path so we can drop its own
    // cross-ref labels — Coflat's native `[@` popup already offers those from the
    // live buffer, and both sources merge into one popup, so including them here
    // double-lists the same id.
    const excludePath = safeRel(c.req.query("path")?.trim() ?? "");
    const sqlLimit = branch !== "main" ? limit * 2 : limit;
    const pageRows = workspacePageRefMatches(c.get("db"), ws.slug, prefix, sqlLimit);
    const remaining = Math.max(0, sqlLimit - pageRows.length);
    const xrefRows = remaining === 0
      ? []
      : workspaceXrefMatches(c.get("db"), ws.slug, prefix, remaining);
    const visibleXrefRows = excludePath ? xrefRows.filter((r) => r.path !== excludePath) : xrefRows;
    const mainSuggestions: RefSuggestion[] = [
        ...pageRows.map((r): RefSuggestion => ({
          id: r.id,
          insert: `[@${r.id}]`,
          display: r.title ? `${r.id} — ${r.title}` : r.id,
        })),
        ...visibleXrefRows.map((r): RefSuggestion => ({
          id: r.id,
          insert: `[@${r.id}]`,
          display: `${r.id} — ${r.title} (${r.path})`,
        })),
      ];
    const branchSuggestions = branch !== "main"
      ? await branchRefSuggestions(c, branch, prefix, limit, excludePath)
      : [];
    return c.json({ suggestions: mergeSuggestions(branchSuggestions, mainSuggestions, limit) });
  });

  // #388: read surface for the page_tags index (frontmatter `tags:`, main-only).
  // The tag-cloud + tag→pages queries are shared with the browse pages via
  // server/page-search.ts so the SQL and IDF ranking are defined once.
  files.get("/:owner/:repo/tags", (c) => {
    return c.json({ tags: workspaceTagCloud(c.get("db"), c.get("workspace").slug) });
  });

  // Pages carrying a given tag.
  files.get("/:owner/:repo/tags/:tag", (c) => {
    const tag = c.req.param("tag");
    if (!tag) return c.json(...bad("tag required"));
    return c.json({ tag, pages: workspacePagesByTag(c.get("db"), c.get("workspace").slug, tag) });
  });

  files.get("/:owner/:repo/refs", async (c) => {
    const ids = [
      ...new Set(
        (c.req.query("ids") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => /^[\w.:-]+$/.test(id))
          .slice(0, 50),
      ),
    ];
    if (ids.length === 0) return c.json({ refs: [] });
    const ws = c.get("workspace");
    const ref = c.req.query("ref")?.trim();
    if (ref) {
      if (!validRequestedBranch(ref)) return c.json(...bad("valid ref required"));
      if (ref !== "main") return c.json(await branchRefs(c, ref, ids));
    }
    return c.json(resolveWorkspaceCrossrefs(c.get("db"), ws.slug, ids));
  });

  files.get("/:owner/:repo/search", (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [] });
    const limit = parseBoundedPositiveInt(c.req.query("limit"), 25, 50);
    try {
      return c.json({ results: searchWorkspacePages(c.get("db"), c.get("workspace").slug, q, limit) });
    } catch (err) {
      return c.json(...bad(`search failed: ${(err as Error).message}`));
    }
  });

  files.get("/:owner/:repo/backlinks", (c) => {
    const id = c.req.query("id");
    if (!id) return c.json(...bad("id required"));
    const ws = c.get("workspace");
    const rows = workspaceBacklinks(c.get("db"), ws.slug, id);
    return c.json({ backlinks: rows });
  });

  files.get("/:owner/:repo/validation", async (c) => {
    const ws = c.get("workspace");
    const { backend, owner, repo } = c.get("repoCtx");
    await ensureWorkspaceStatusesBackfilled(c.get("db"), backend, owner, repo, ws.slug);
    return c.json(workspaceValidation(c.get("db"), ws.slug) satisfies WorkspaceValidation);
  });
}

function mergeSuggestions(primary: readonly RefSuggestion[], secondary: readonly RefSuggestion[], limit: number): RefSuggestion[] {
  const seen = new Set<string>();
  const mergedPrimary: RefSuggestion[] = [];
  const mergedSecondary: RefSuggestion[] = [];
  for (const suggestion of primary) {
    if (seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    mergedPrimary.push(suggestion);
  }
  for (const suggestion of secondary) {
    if (seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    mergedSecondary.push(suggestion);
  }
  const sortSuggestions = (items: RefSuggestion[]) =>
    items.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  return [...sortSuggestions(mergedPrimary), ...sortSuggestions(mergedSecondary)].slice(0, limit);
}

async function branchRefSuggestions(
  c: import("hono").Context<AppEnv>,
  branch: string,
  prefix: string,
  limit: number,
  excludePath: string | null,
): Promise<RefSuggestion[]> {
  const { backend, owner, repo } = c.get("repoCtx");
  let tree = getCachedTree(owner, repo, branch);
  if (!tree) {
    try {
      tree = await backend.getTree(owner, repo, branch, true);
      setCachedTree(owner, repo, branch, tree);
    } catch (err) {
      if (err instanceof WorkspaceBackendError && (err.status === 404 || err.status === 400)) return [];
      throw err;
    }
  }
  const markdownFiles = tree
    .filter((entry) => entry.type === "blob" && fileKindForPath(entry.path) === "markdown" && (entry.size ?? 0) <= 512_000)
    .slice(0, 80);
  const cacheKey = branchRefCacheKey(owner, repo, branch, markdownFiles);
  let branchRefs = getCachedBranchRefs(cacheKey);
  if (!branchRefs) {
    branchRefs = await parseBranchRefs(c, branch, markdownFiles);
    setCachedBranchRefs(cacheKey, branchRefs);
  }
  const suggestions: RefSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of branchRefs) {
    if (excludePath && entry.path === excludePath) continue;
    addBranchSuggestion(suggestions, seen, entry.id, entry.title, entry.path, prefix, limit);
    if (suggestions.length >= limit) break;
  }
  return suggestions.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)).slice(0, limit);
}

async function parseBranchRefs(
  c: import("hono").Context<AppEnv>,
  branch: string,
  markdownFiles: readonly { path: string }[],
): Promise<readonly BranchRefEntry[]> {
  const { backend, owner, repo } = c.get("repoCtx");
  const entries: BranchRefEntry[] = [];
  const chunkSize = 8;
  for (let i = 0; i < markdownFiles.length; i += chunkSize) {
    const chunk = markdownFiles.slice(i, i + chunkSize);
    const parsed = await Promise.all(chunk.map(async (entry): Promise<BranchRefEntry[]> => {
      const rel = safeRel(entry.path);
      if (!rel) return [];
      const source = await backend.getRawFile(owner, repo, branch, rel).catch(() => null);
      if (source === null) return [];
      const parsedDoc = parseCoflatFrontmatter(source);
      const frontmatter = (parsedDoc.frontmatter ?? {}) as Record<string, unknown>;
      const out: BranchRefEntry[] = [];
      if (typeof frontmatter.id === "string") {
        out.push({
          id: frontmatter.id,
          title: typeof frontmatter.title === "string" ? frontmatter.title : extractCoflatFirstH1(parsedDoc.body),
          path: rel,
          kind: "page",
          line: null,
        });
      }
      for (const target of extractCoflatXrefTargets(source)) {
        out.push({ id: target.id, title: target.label, path: rel, kind: target.kind, line: target.line });
      }
      return out;
    }));
    entries.push(...parsed.flat());
  }
  return entries.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
}

function addBranchSuggestion(
  suggestions: RefSuggestion[],
  seen: Set<string>,
  id: string,
  title: string | null,
  path: string,
  prefix: string,
  limit: number,
): void {
  if (suggestions.length >= limit || seen.has(id) || !suggestionMatches(id, title, prefix)) return;
  seen.add(id);
  suggestions.push({
    id,
    insert: `[@${id}]`,
    display: title ? `${id} — ${title} (${path})` : `${id} (${path})`,
  });
}

function suggestionMatches(id: string, title: string | null, prefix: string): boolean {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return true;
  return id.toLowerCase().startsWith(needle) || Boolean(title?.toLowerCase().includes(needle));
}

async function branchRefs(
  c: import("hono").Context<AppEnv>,
  ref: string,
  ids: readonly string[],
): Promise<{ refs: Array<Record<string, unknown>>; ambiguous_refs: Array<{ id: string; paths: string[] }> }> {
  const { backend, owner, repo } = c.get("repoCtx");
  let tree = getCachedTree(owner, repo, ref);
  if (!tree) {
    try {
      tree = await backend.getTree(owner, repo, ref, true);
      setCachedTree(owner, repo, ref, tree);
    } catch (err) {
      if (err instanceof WorkspaceBackendError && (err.status === 404 || err.status === 400)) return { refs: [], ambiguous_refs: [] };
      throw err;
    }
  }
  const markdownFiles = tree
    .filter((entry) => entry.type === "blob" && fileKindForPath(entry.path) === "markdown" && (entry.size ?? 0) <= 512_000);
  const cacheKey = branchRefCacheKey(owner, repo, ref, markdownFiles);
  let entries = getCachedBranchRefs(cacheKey);
  if (!entries) {
    entries = await parseBranchRefs(c, ref, markdownFiles);
    setCachedBranchRefs(cacheKey, entries);
  }

  const wanted = new Set(ids);
  const grouped = new Map<string, BranchRefEntry[]>();
  for (const entry of entries) {
    if (!wanted.has(entry.id)) continue;
    grouped.set(entry.id, [...(grouped.get(entry.id) ?? []), entry]);
  }

  const refs: Array<Record<string, unknown>> = [];
  const ambiguousRefs: Array<{ id: string; paths: string[] }> = [];
  for (const id of ids) {
    const matches = grouped.get(id) ?? [];
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      const perPath = new Map<string, number>();
      for (const match of matches) perPath.set(match.path, (perPath.get(match.path) ?? 0) + 1);
      ambiguousRefs.push({
        id,
        paths: [...perPath.entries()].map(([path, count]) => count > 1 ? `${path} (${count} definitions)` : path),
      });
      continue;
    }
    const match = matches[0];
    refs.push({
      id: match.id,
      path: match.path,
      kind: match.kind,
      label: match.title ?? match.id,
      ...(match.kind === "page" ? {} : { fragment: match.id, line: match.line }),
    });
  }
  return { refs, ambiguous_refs: ambiguousRefs };
}
