#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildReferenceCatalog,
  extractDocumentReferences,
  parseFrontmatter as parseCoflatFrontmatter,
  resolveMarkdownReferencePathFromDocument,
} from "@chaoxu/coflat/parse";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { defaultApiUrl, loadDotenvDev } from "./lib/env-dev.mjs";

class HttpError extends Error {
  constructor(message, { status, data }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.data = data;
  }
}

export function parseWorkspace(value) {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new Error("--workspace must be <owner>/<repo>.");
  }
  const [owner, repo] = value.split("/");
  return { owner, repo, slug: value };
}

export function parseFileSpec(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--file requires a value.");
  }
  const separator = value.indexOf("=");
  const workspacePath = separator === -1 ? value : value.slice(0, separator);
  const localPath = separator === -1 ? value : value.slice(separator + 1);
  if (!workspacePath || !localPath) {
    throw new Error("--file must be <workspace-path> or <workspace-path>=<local-path>.");
  }
  if (workspacePath.startsWith("/") || workspacePath.split("/").includes("..")) {
    throw new Error(`Invalid workspace path for --file: ${workspacePath}`);
  }
  return { workspacePath, localPath };
}

export function normalizeApiBase(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("--api is required.");
  return trimmed.replace(/\/+$/, "");
}

export function tokenFromOptions(options, env = process.env) {
  const token = options.token ?? env.COSHEAF_TOKEN ?? env.COSHEAF_PAT ?? env.COSHEAF_API_TOKEN ?? "";
  if (!token.trim()) {
    throw new Error("A Cosheaf API token is required. Pass --token or set COSHEAF_TOKEN.");
  }
  return token;
}

export function loadPrFiles(fileSpecs, readFile = readFileSync) {
  if (!Array.isArray(fileSpecs) || fileSpecs.length === 0) {
    throw new Error("pr-from-files requires at least one --file.");
  }
  return fileSpecs.map((spec) => {
    const parsed = parseFileSpec(spec);
    return {
      ...parsed,
      content: readFile(parsed.localPath, "utf8"),
    };
  });
}

function workspacePath(workspace) {
  const { owner, repo } = parseWorkspace(workspace);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function jsonHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function request(apiBase, pathname, { token, method = "GET", body } = {}) {
  const headers = token ? jsonHeaders(token) : {};
  if (body === undefined) delete headers["content-type"];
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new HttpError(`${method} ${pathname} -> ${response.status}: ${detail}`, {
      status: response.status,
      data,
    });
  }
  return data;
}

async function createBranch(apiBase, workspace, token, branch) {
  try {
    await request(apiBase, `${workspacePath(workspace)}/branches`, {
      token,
      method: "POST",
      body: { name: branch },
    });
    return { created: true };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      return { created: false };
    }
    throw error;
  }
}

async function writeFile(apiBase, workspace, token, file, branch) {
  const query = new URLSearchParams({ path: file.workspacePath, branch });
  const result = await request(apiBase, `${workspacePath(workspace)}/file?${query.toString()}`, {
    token,
    method: "PUT",
    body: { content: file.content },
  });
  return {
    path: file.workspacePath,
    localPath: file.localPath,
    cosheafId: result?.meta?.id ?? null,
  };
}

async function findOpenPull(apiBase, workspace, token, { head, base }) {
  const query = new URLSearchParams({ state: "open" });
  const data = await request(apiBase, `${workspacePath(workspace)}/pulls?${query.toString()}`, { token });
  const pulls = Array.isArray(data?.pulls) ? data.pulls : [];
  return pulls.find((pull) => pull?.head_ref === head && pull?.base_ref === base && !pull?.merged) ?? null;
}

async function openPull(apiBase, workspace, token, payload) {
  const existing = await findOpenPull(apiBase, workspace, token, payload);
  if (existing) return { pull: existing, reused: true };
  try {
    const pull = await request(apiBase, `${workspacePath(workspace)}/pulls`, {
      token,
      method: "POST",
      body: payload,
    });
    return { pull, reused: false };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      const retryExisting = await findOpenPull(apiBase, workspace, token, payload);
      if (retryExisting) return { pull: retryExisting, reused: true };
    }
    throw error;
  }
}

export async function prFromFiles(options) {
  const apiBase = normalizeApiBase(options.api);
  const workspace = parseWorkspace(options.workspace).slug;
  const base = options.base ?? "main";
  const files = loadPrFiles(options.file);
  if (!options.branch) throw new Error("--branch is required.");
  if (!options.title) throw new Error("--title is required.");

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      api: apiBase,
      workspace,
      branch: options.branch,
      base,
      title: options.title,
      files: files.map(({ workspacePath, localPath }) => ({ path: workspacePath, localPath })),
    };
  }

  const token = tokenFromOptions(options);
  const branchResult = await createBranch(apiBase, workspace, token, options.branch);
  const written = [];
  for (const file of files) {
    written.push(await writeFile(apiBase, workspace, token, file, options.branch));
  }
  const pullResult = await openPull(apiBase, workspace, token, {
    head: options.branch,
    base,
    title: options.title,
    body: options.body ?? "",
  });
  const number = pullResult.pull?.number ?? null;
  return {
    ok: true,
    api: apiBase,
    workspace,
    branch: options.branch,
    branchCreated: branchResult.created,
    base,
    files: written,
    pull: {
      number,
      reused: pullResult.reused,
      path: number === null ? null : `/${workspace}/pulls/${number}`,
    },
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.dryRun) {
    console.log(`Would write ${result.files.length} file(s) to ${result.workspace}:${result.branch}`);
    console.log(`Would open PR '${result.title}' into ${result.base}`);
    return;
  }
  console.log(`Wrote ${result.files.length} file(s) to ${result.workspace}:${result.branch}`);
  if (result.pull?.reused) {
    console.log(`Reused PR #${result.pull.number}: ${result.pull.path}`);
  } else {
    console.log(`Opened PR #${result.pull.number}: ${result.pull.path}`);
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".cosheaf"]);

function findMarkdownFiles(dir) {
  const mdFiles = [];
  const scanErrors = [];
  function walk(currentDir) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (scanError) {
      const relDir = path.relative(dir, currentDir).split(path.sep).join("/") || ".";
      scanErrors.push({
        docPath: relDir,
        kind: "workspace",
        status: "error",
        message: `Failed to scan directory '${relDir}': ${scanError instanceof Error ? scanError.message : String(scanError)}`,
      });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        mdFiles.push(path.join(currentDir, entry.name));
      }
    }
  }
  walk(dir);
  mdFiles.sort();
  return { mdFiles, scanErrors };
}

function extractFrontmatterAndBody(content) {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const openLen = content.startsWith("---\r\n") ? 5 : (content.startsWith("---\n") ? 4 : null);
  if (!openLen) {
    return { frontmatter: {}, body: content };
  }
  const closeMatch = content.slice(openLen).match(/\r?\n---\r?(\n|$)/);
  if (!closeMatch) {
    return { frontmatter: {}, body: content };
  }
  const yamlEnd = openLen + closeMatch.index;
  const bodyStart = yamlEnd + closeMatch[0].length;
  const yamlText = content.slice(openLen, yamlEnd);
  const body = content.slice(bodyStart);
  try {
    const parsed = parseYaml(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed, body };
    }
  } catch (_error) {
    // Bad yaml
  }
  return { frontmatter: {}, body: content };
}

function normalizeTheoremStatus(raw) {
  if (typeof raw !== "string") return "proved";
  const s = raw.trim().toLowerCase();
  if (s === "draft" || s === "conjecture" || s === "raw" || s === "locally_tested") {
    return "draft";
  }
  if (s === "refuted" || s === "obsolete") {
    return "refuted";
  }
  return "proved";
}

const binaryAvailabilityCache = new Map();
function isBinaryAvailable(cmd) {
  const cacheKey = `${cmd}:${process.env.PATH ?? ""}`;
  if (binaryAvailabilityCache.has(cacheKey)) {
    return binaryAvailabilityCache.get(cacheKey);
  }
  try {
    const res = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    const available = !(res.error && res.error.code === "ENOENT");
    binaryAvailabilityCache.set(cacheKey, available);
    return available;
  } catch (_error) {
    binaryAvailabilityCache.set(cacheKey, false);
    return false;
  }
}

export function verifyLocalWorkspace(options = {}) {
  const rootDir = path.resolve(options.dir ?? process.cwd());
  if (!existsSync(rootDir)) {
    return {
      ok: false,
      dir: rootDir,
      checked_files: 0,
      verification_results: [
        {
          docPath: rootDir,
          kind: "workspace",
          status: "error",
          message: `Directory does not exist: ${rootDir}`,
        },
      ],
      tainted_refs: [],
    };
  }

  let rootStat = null;
  try {
    rootStat = statSync(rootDir);
  } catch (statError) {
    return {
      ok: false,
      dir: rootDir,
      checked_files: 0,
      verification_results: [
        {
          docPath: rootDir,
          kind: "workspace",
          status: "error",
          message: statError instanceof Error ? statError.message : String(statError),
        },
      ],
      tainted_refs: [],
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      dir: rootDir,
      checked_files: 0,
      verification_results: [
        {
          docPath: rootDir,
          kind: "workspace",
          status: "error",
          message: `Not a directory: ${rootDir}`,
        },
      ],
      tainted_refs: [],
    };
  }

  const { mdFiles: mdFilePaths, scanErrors } = findMarkdownFiles(rootDir);
  const docs = [];
  const verification_results = [...scanErrors];

  for (const fullPath of mdFilePaths) {
    const relPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    let content = "";
    try {
      content = readFileSync(fullPath, "utf8");
    } catch (readError) {
      verification_results.push({
        docPath: relPath,
        kind: "workspace",
        status: "error",
        message: `Failed to read file '${relPath}': ${readError instanceof Error ? readError.message : String(readError)}`,
      });
      continue;
    }
    let frontmatter = {};
    let body = content;
    const coflatParsed = parseCoflatFrontmatter(content);
    if (coflatParsed.frontmatter !== null && typeof coflatParsed.frontmatter === "object") {
      frontmatter = coflatParsed.frontmatter;
      body = coflatParsed.body;
    } else if (content.includes("---")) {
      const fallback = extractFrontmatterAndBody(content);
      frontmatter = fallback.frontmatter;
      body = fallback.body;
    }
    const id = typeof frontmatter.id === "string" && frontmatter.id.trim() ? frontmatter.id.trim() : null;
    const rawStatus = typeof frontmatter.status === "string" ? frontmatter.status.trim() : null;
    const status = normalizeTheoremStatus(rawStatus);
    const catalog = buildReferenceCatalog(content);
    const targets = (catalog.targets || []).filter(
      (t) => typeof t.id === "string" && t.id.trim().length > 0,
    );
    const localXrefIds = new Set(targets.map((t) => t.id.trim()));
    const links = extractDocumentReferences(content);
    const baseName = path.basename(relPath);
    const stem = path.basename(relPath, ".md");
    const relStem = relPath.replace(/\.md$/i, "");

    docs.push({
      fullPath,
      relPath,
      baseName,
      stem,
      relStem,
      id,
      rawStatus,
      status,
      frontmatter,
      body,
      targets,
      localXrefIds,
      links,
    });
  }

  const docById = new Map();
  const docByPath = new Map();
  const xrefCounts = new Map();
  const docByXref = new Map();

  for (const doc of docs) {
    if (doc.id) {
      docById.set(doc.id, doc);
    }
    docByPath.set(doc.relPath, doc);
    if (!docByPath.has(doc.relStem)) docByPath.set(doc.relStem, doc);

    for (const target of doc.targets) {
      if (typeof target.id === "string" && target.id.trim()) {
        const tid = target.id.trim();
        const count = (xrefCounts.get(tid) ?? 0) + 1;
        xrefCounts.set(tid, count);
        if (count === 1) {
          docByXref.set(tid, doc);
        } else {
          docByXref.delete(tid);
        }
      }
    }
  }

  function resolveLinkTargetDoc(srcDoc, link) {
    if (!link || typeof link !== "object") return null;
    if (link.kind === "id") {
      if (srcDoc.localXrefIds && srcDoc.localXrefIds.has(link.ref)) {
        return srcDoc;
      }
      const byId = docById.get(link.ref);
      if (byId) return byId;
      if (xrefCounts.get(link.ref) === 1) {
        return docByXref.get(link.ref) ?? null;
      }
      return null;
    }
    if (link.kind === "path") {
      const [linkPath] = String(link.ref ?? "").split("#", 1);
      if (!linkPath) return null;
      const resolved = resolveMarkdownReferencePathFromDocument(srcDoc.relPath, linkPath);
      return docByPath.get(resolved) || docByPath.get(`${resolved}.md`) || null;
    }
    return null;
  }

  const sortedAdj = new Map();
  const revAdj = new Map();
  for (const doc of docs) {
    sortedAdj.set(doc.relPath, []);
    revAdj.set(doc.relPath, []);
  }

  for (const doc of docs) {
    const targets = new Set();
    for (const link of doc.links) {
      const targetDoc = resolveLinkTargetDoc(doc, link);
      if (targetDoc && targetDoc !== doc) {
        targets.add(targetDoc.relPath);
      }
    }
    const sortedTargets = Array.from(targets).sort((a, b) => a.localeCompare(b));
    sortedAdj.set(doc.relPath, sortedTargets);
    for (const tPath of sortedTargets) {
      revAdj.get(tPath).push(doc.relPath);
    }
  }

  for (const doc of docs) {
    revAdj.get(doc.relPath).sort((a, b) => a.localeCompare(b));
  }

  const unprovedDocs = docs
    .filter((d) => d.status !== "proved")
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const distToTaint = new Map();
  const nextHopToTaint = new Map();
  const nearestTaintDoc = new Map();

  const queue = [];
  for (const doc of unprovedDocs) {
    distToTaint.set(doc.relPath, 0);
    nextHopToTaint.set(doc.relPath, null);
    nearestTaintDoc.set(doc.relPath, doc);
    queue.push(doc.relPath);
  }

  let queueHead = 0;
  while (queueHead < queue.length) {
    const currRelPath = queue[queueHead++];
    const currDist = distToTaint.get(currRelPath);
    const currTaintDoc = nearestTaintDoc.get(currRelPath);

    const predecessors = revAdj.get(currRelPath) ?? [];
    for (const predRelPath of predecessors) {
      const predDoc = docByPath.get(predRelPath);
      if (!predDoc || predDoc.status !== "proved") {
        continue;
      }
      if (!distToTaint.has(predRelPath)) {
        distToTaint.set(predRelPath, currDist + 1);
        nextHopToTaint.set(predRelPath, currRelPath);
        nearestTaintDoc.set(predRelPath, currTaintDoc);
        queue.push(predRelPath);
      } else if (distToTaint.get(predRelPath) === currDist + 1) {
        const existingNextHop = nextHopToTaint.get(predRelPath);
        if (existingNextHop && currRelPath.localeCompare(existingNextHop) < 0) {
          nextHopToTaint.set(predRelPath, currRelPath);
          nearestTaintDoc.set(predRelPath, currTaintDoc);
        }
      }
    }
  }

  const tainted_refs = [];
  const seenTaints = new Set();

  for (const srcDoc of docs) {
    if (srcDoc.status !== "proved") continue;
    for (const link of srcDoc.links) {
      const directDoc = resolveLinkTargetDoc(srcDoc, link);
      if (!directDoc || directDoc === srcDoc) continue;

      if (directDoc.status !== "proved") {
        const taintKey = `${srcDoc.relPath}->${directDoc.relPath}:${link.raw}:${link.line ?? ""}`;
        if (!seenTaints.has(taintKey)) {
          seenTaints.add(taintKey);
          tainted_refs.push({
            source_path: srcDoc.relPath,
            source_id: srcDoc.id,
            target_path: directDoc.relPath,
            target_id: directDoc.id ?? (link.kind === "id" ? link.ref : directDoc.relPath),
            target_status: directDoc.rawStatus || directDoc.status,
            ref: link.ref,
            target_label: link.raw,
            line: link.line ?? null,
          });
        }
      } else if (distToTaint.has(directDoc.relPath)) {
        const targetDoc = nearestTaintDoc.get(directDoc.relPath);
        const taintKey = `${srcDoc.relPath}->${targetDoc.relPath}:${link.raw}:${link.line ?? ""}`;
        if (!seenTaints.has(taintKey)) {
          seenTaints.add(taintKey);
          const viaPath = [directDoc.relPath];
          let curr = directDoc.relPath;
          while (nextHopToTaint.get(curr)) {
            curr = nextHopToTaint.get(curr);
            viaPath.push(curr);
          }
          tainted_refs.push({
            source_path: srcDoc.relPath,
            source_id: srcDoc.id,
            target_path: targetDoc.relPath,
            target_id: targetDoc.id ?? targetDoc.relPath,
            target_status: targetDoc.rawStatus || targetDoc.status,
            ref: link.ref,
            target_label: link.raw,
            line: link.line ?? null,
            via_path: viaPath,
          });
        }
      }
    }
  }

  for (const doc of docs) {
    if (!Array.isArray(doc.frontmatter.verify)) continue;
    for (const item of doc.frontmatter.verify) {
      if (!item || typeof item !== "object") continue;
      const kind = String(item.kind ?? "").trim().toLowerCase();
      const timeoutMs = typeof item.timeoutMs === "number" && item.timeoutMs > 0 ? item.timeoutMs : 30000;

      if (kind === "python") {
        const script = item.script ?? item.file ?? item.path;
        if (!script) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "python",
            status: "fail",
            message: "Missing script path in python verifier specification",
          });
          continue;
        }
        let scriptPath = path.isAbsolute(script) ? script : path.resolve(rootDir, script);
        if (!existsSync(scriptPath)) {
          const docDirScript = path.resolve(path.dirname(doc.fullPath), script);
          if (existsSync(docDirScript)) {
            scriptPath = docDirScript;
          }
        }
        if (!existsSync(scriptPath)) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "python",
            status: "fail",
            message: `Checker script not found: ${script}`,
          });
          continue;
        }
        if (!isBinaryAvailable("python3")) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "python",
            status: "skipped",
            message: "python3 is not installed or not in PATH",
          });
          continue;
        }
        try {
          const res = spawnSync("python3", [scriptPath, doc.fullPath], {
            cwd: rootDir,
            encoding: "utf8",
            timeout: timeoutMs,
          });
          if (res.error) {
            if (res.error.code === "ENOENT") {
              verification_results.push({
                docPath: doc.relPath,
                kind: "python",
                status: "skipped",
                message: "python3 is not installed",
              });
            } else if (res.error.code === "ETIMEDOUT") {
              verification_results.push({
                docPath: doc.relPath,
                kind: "python",
                status: "fail",
                message: `Execution timed out after ${timeoutMs}ms`,
              });
            } else {
              verification_results.push({
                docPath: doc.relPath,
                kind: "python",
                status: "fail",
                message: res.error.message,
              });
            }
          } else if (res.status === 0) {
            const firstLine = (res.stdout || "Verification passed").trim().split("\n")[0] || "Verification passed";
            verification_results.push({
              docPath: doc.relPath,
              kind: "python",
              status: "pass",
              message: firstLine,
            });
          } else {
            const errMsg = (res.stderr || res.stdout || `Exited with code ${res.status}`).trim().split("\n")[0];
            verification_results.push({
              docPath: doc.relPath,
              kind: "python",
              status: "fail",
              message: errMsg || `Exited with code ${res.status}`,
            });
          }
        } catch (error) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "python",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (kind === "sat") {
        const file = item.file ?? item.path;
        if (!file) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "sat",
            status: "fail",
            message: "Missing file path in SAT verifier specification",
          });
          continue;
        }
        let filePath = path.isAbsolute(file) ? file : path.resolve(rootDir, file);
        if (!existsSync(filePath)) {
          const docDirFile = path.resolve(path.dirname(doc.fullPath), file);
          if (existsSync(docDirFile)) {
            filePath = docDirFile;
          }
        }
        if (!existsSync(filePath)) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "sat",
            status: "fail",
            message: `SAT file not found: ${file}`,
          });
          continue;
        }
        if (!isBinaryAvailable("kissat")) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "sat",
            status: "skipped",
            message: "kissat is not installed or not in PATH",
          });
          continue;
        }
        try {
          const res = spawnSync("kissat", [filePath], {
            cwd: rootDir,
            encoding: "utf8",
            timeout: timeoutMs,
          });
          if (res.error) {
            if (res.error.code === "ENOENT") {
              verification_results.push({
                docPath: doc.relPath,
                kind: "sat",
                status: "skipped",
                message: "kissat is not installed",
              });
            } else {
              verification_results.push({
                docPath: doc.relPath,
                kind: "sat",
                status: "fail",
                message: res.error.message,
              });
            }
          } else {
            let parsedLine = null;
            for (const line of (res.stdout || "").split(/\r?\n/)) {
              const trimmed = line.trim();
              if (/^s\s+SATISFIABLE$/i.test(trimmed)) {
                parsedLine = "sat";
                break;
              }
              if (/^s\s+UNSATISFIABLE$/i.test(trimmed)) {
                parsedLine = "unsat";
                break;
              }
            }

            let outcome = null;
            if (res.status !== 0 && res.status !== 10 && res.status !== 20) {
              outcome = null;
            } else if (res.status === 10 && parsedLine !== "unsat") {
              outcome = "sat";
            } else if (res.status === 20 && parsedLine !== "sat") {
              outcome = "unsat";
            } else if (res.status === 0 && (parsedLine === "sat" || parsedLine === "unsat")) {
              outcome = parsedLine;
            } else {
              outcome = null;
            }

            const expected = typeof item.expect === "string" ? item.expect.toLowerCase() : null;
            if (!outcome) {
              verification_results.push({
                docPath: doc.relPath,
                kind: "sat",
                status: "fail",
                message: res.status !== 0 && res.status !== 10 && res.status !== 20
                  ? `SAT solver failed with exit code ${res.status}`
                  : `SAT solver did not produce a definitive result (exit code ${res.status})`,
              });
            } else if (expected) {
              if (outcome === expected) {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "sat",
                  status: "pass",
                  message: `SAT solver returned expected ${expected}`,
                });
              } else {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "sat",
                  status: "fail",
                  message: `SAT solver outcome '${outcome}' did not match expected '${expected}'`,
                });
              }
            } else {
              verification_results.push({
                docPath: doc.relPath,
                kind: "sat",
                status: "pass",
                message: `SAT solver completed (${outcome})`,
              });
            }
          }
        } catch (error) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "sat",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (kind === "smt") {
        const file = item.file ?? item.path;
        if (!file) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "smt",
            status: "fail",
            message: "Missing file path in SMT verifier specification",
          });
          continue;
        }
        let filePath = path.isAbsolute(file) ? file : path.resolve(rootDir, file);
        if (!existsSync(filePath)) {
          const docDirFile = path.resolve(path.dirname(doc.fullPath), file);
          if (existsSync(docDirFile)) {
            filePath = docDirFile;
          }
        }
        if (!existsSync(filePath)) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "smt",
            status: "fail",
            message: `SMT file not found: ${file}`,
          });
          continue;
        }
        if (!isBinaryAvailable("z3")) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "smt",
            status: "skipped",
            message: "z3 is not installed or not in PATH",
          });
          continue;
        }
        try {
          const res = spawnSync("z3", ["-smt2", filePath], {
            cwd: rootDir,
            encoding: "utf8",
            timeout: timeoutMs,
          });
          if (res.error) {
            if (res.error.code === "ENOENT") {
              verification_results.push({
                docPath: doc.relPath,
                kind: "smt",
                status: "skipped",
                message: "z3 is not installed",
              });
            } else {
              verification_results.push({
                docPath: doc.relPath,
                kind: "smt",
                status: "fail",
                message: res.error.message,
              });
            }
          } else if (res.status !== 0) {
            const errMsg = (res.stderr || res.stdout || `SMT solver failed with exit code ${res.status}`).trim().split("\n")[0];
            verification_results.push({
              docPath: doc.relPath,
              kind: "smt",
              status: "fail",
              message: errMsg || `SMT solver failed with exit code ${res.status}`,
            });
          } else {
            let outcome = "unknown";
            for (const line of (res.stdout || "").split(/\r?\n/)) {
              const trimmed = line.trim().toLowerCase();
              if (trimmed === "sat" || trimmed === "unsat") {
                outcome = trimmed;
                break;
              }
            }
            if (outcome === "unknown") {
              verification_results.push({
                docPath: doc.relPath,
                kind: "smt",
                status: "fail",
                message: "SMT solver did not return sat or unsat",
              });
            } else {
              const expected = typeof item.expect === "string" ? item.expect.toLowerCase() : null;
              if (expected) {
                if (outcome === expected) {
                  verification_results.push({
                    docPath: doc.relPath,
                    kind: "smt",
                    status: "pass",
                    message: `SMT solver returned expected ${expected}`,
                  });
                } else {
                  verification_results.push({
                    docPath: doc.relPath,
                    kind: "smt",
                    status: "fail",
                    message: `SMT solver outcome '${outcome}' did not match expected '${expected}'`,
                  });
                }
              } else {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "smt",
                  status: "pass",
                  message: `SMT solver completed (${outcome})`,
                });
              }
            }
          }
        } catch (error) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "smt",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (kind === "lean") {
        const file = item.file ?? item.path;
        const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
        if (!file && !symbol) {
          verification_results.push({
            docPath: doc.relPath,
            kind: "lean",
            status: "fail",
            message: "Missing file or symbol in Lean verifier specification",
          });
          continue;
        }
        if (file) {
          let filePath = path.isAbsolute(file) ? file : path.resolve(rootDir, file);
          if (!existsSync(filePath)) {
            const docDirFile = path.resolve(path.dirname(doc.fullPath), file);
            if (existsSync(docDirFile)) {
              filePath = docDirFile;
            }
          }
          if (!existsSync(filePath)) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "fail",
              message: `Lean file not found: ${file}`,
            });
            continue;
          }
          if (!isBinaryAvailable("lean")) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "skipped",
              message: "lean is not installed or not in PATH",
            });
            continue;
          }
          try {
            const res = spawnSync("lean", [filePath], {
              cwd: rootDir,
              encoding: "utf8",
              timeout: timeoutMs,
            });
            if (res.error) {
              if (res.error.code === "ENOENT") {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "lean",
                  status: "skipped",
                  message: "lean is not installed",
                });
              } else {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "lean",
                  status: "fail",
                  message: res.error.message,
                });
              }
            } else if (res.status === 0) {
              verification_results.push({
                docPath: doc.relPath,
                kind: "lean",
                status: "pass",
                message: "Lean verification succeeded",
              });
            } else {
              const errMsg = (res.stderr || res.stdout || `Lean exited with code ${res.status}`).trim().split("\n")[0];
              verification_results.push({
                docPath: doc.relPath,
                kind: "lean",
                status: "fail",
                message: errMsg || `Lean exited with code ${res.status}`,
              });
            }
          } catch (error) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "fail",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          if (!/^[A-Za-z_][\w.']*$/.test(symbol)) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "fail",
              message: `Invalid Lean symbol name: ${symbol}`,
              alignment: "not_checked",
            });
            continue;
          }
          if (!isBinaryAvailable("lean")) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "skipped",
              message: "lean is not installed or not in PATH",
              alignment: "not_checked",
            });
            continue;
          }
          let tmpDir = null;
          try {
            tmpDir = mkdtempSync(path.join(tmpdir(), "lean-verify-"));
            const probeFile = path.join(tmpDir, "Probe.lean");
            writeFileSync(probeFile, `#check ${symbol}\n`, "utf8");
            const res = spawnSync("lean", [probeFile], {
              cwd: rootDir,
              encoding: "utf8",
              timeout: timeoutMs,
            });
            if (res.error) {
              if (res.error.code === "ENOENT") {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "lean",
                  status: "skipped",
                  message: "lean is not installed",
                  alignment: "not_checked",
                });
              } else {
                verification_results.push({
                  docPath: doc.relPath,
                  kind: "lean",
                  status: "fail",
                  message: res.error.message,
                  alignment: "not_checked",
                });
              }
            } else if (res.status === 0) {
              verification_results.push({
                docPath: doc.relPath,
                kind: "lean",
                status: "pass",
                message: (res.stdout || "").trim() || "Lean symbol check passed",
                alignment: "not_checked",
              });
            } else {
              const errMsg = (res.stderr || res.stdout || `Lean symbol check failed with code ${res.status}`).trim().split("\n")[0];
              verification_results.push({
                docPath: doc.relPath,
                kind: "lean",
                status: "fail",
                message: errMsg || `Lean symbol check failed with code ${res.status}`,
                alignment: "not_checked",
              });
            }
          } catch (error) {
            verification_results.push({
              docPath: doc.relPath,
              kind: "lean",
              status: "fail",
              message: error instanceof Error ? error.message : String(error),
              alignment: "not_checked",
            });
          } finally {
            if (tmpDir) {
              try {
                rmSync(tmpDir, { recursive: true, force: true });
              } catch (_cleanupError) {
                // ignore cleanup error
              }
            }
          }
        }
      } else {
        verification_results.push({
          docPath: doc.relPath,
          kind: kind || "unknown",
          status: "skipped",
          message: `Unsupported verifier kind '${kind}'`,
        });
      }
    }
  }

  const hasFailures = verification_results.some(
    (r) => r.status === "fail" || r.status === "error"
  );
  const ok = !hasFailures && tainted_refs.length === 0;

  return {
    ok,
    dir: rootDir,
    checked_files: mdFilePaths.length,
    verification_results,
    tainted_refs,
  };
}

export function buildProgram() {
  const program = new Command("cosheaf-tea")
    .description("tea-shaped Cosheaf typed API helper for AI clients")
    .option("--api <url>", "Cosheaf API base URL", defaultApiUrl())
    .option("--workspace <owner/repo>", "Cosheaf workspace", process.env.COSHEAF_WORKSPACE)
    .option("--token <token>", "Cosheaf API token; defaults to COSHEAF_TOKEN, COSHEAF_PAT, or COSHEAF_API_TOKEN")
    .option("--json", "print machine-readable JSON", false);

  program
    .command("verify")
    .description("verify local markdown theorem status dependencies and executable verifiers")
    .option("--dir <path>", "workspace directory to verify", process.cwd())
    .action((opts) => {
      const globals = program.opts();
      const result = verifyLocalWorkspace({ dir: opts.dir });
      if (globals.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Verified ${result.checked_files} markdown file(s) in ${result.dir}`);
        for (const r of result.verification_results) {
          console.log(`  [${r.status.toUpperCase()}] ${r.docPath} (${r.kind}): ${r.message}`);
        }
        for (const t of result.tainted_refs) {
          console.log(`  [TAINTED] ${t.source_path} (proved) depends on ${t.target_path} (${t.target_status})`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("pr-from-files")
    .description("write local files to a Cosheaf branch and open or reuse a PR")
    .requiredOption("--branch <name>", "Cosheaf branch to write")
    .requiredOption("--title <title>", "pull request title")
    .option("--base <name>", "base branch", "main")
    .option("--body <text>", "pull request body", "")
    .option("--file <workspace-path[=local-path]>", "file to upload; repeatable", (value, previous) => [
      ...(previous ?? []),
      value,
    ])
    .option("--dry-run", "print the planned writes without calling Cosheaf", false)
    .action(async (opts) => {
      const globals = program.opts();
      const result = await prFromFiles({ ...globals, ...opts });
      printResult(result, globals.json);
    });

  return program;
}

export async function main(argv = process.argv) {
  loadDotenvDev();
  await buildProgram().parseAsync(normalizeArgv(argv));
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
