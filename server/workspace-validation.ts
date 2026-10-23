import type Database from "better-sqlite3";
import { parseFrontmatterYaml } from "../shared/frontmatter-yaml.js";
import {
  normalizeTheoremStatus,
  type TheoremStatus,
} from "../shared/theorem-status.js";
import type {
  CyclicReference,
  TaintedReference,
  WorkspaceValidation,
} from "../shared/validation.js";
import type { WorkspaceBackend } from "./workspace-backend.js";

interface TarjanFrame {
  nodeId: string;
  neighbors: readonly string[];
  neighborIndex: number;
}

export async function ensureWorkspaceStatusesBackfilled(
  db: Database.Database,
  backend: Pick<WorkspaceBackend, "getRawFile">,
  owner: string,
  repo: string,
  workspaceSlug: string,
): Promise<void> {
  const missing = db
    .prepare(
      "SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ? AND status IS NULL",
    )
    .all(workspaceSlug) as Array<{ cosheaf_id: string; forgejo_id: string }>;
  if (missing.length === 0) return;

  const checkStillNull = db.prepare(
    "SELECT 1 FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ? AND forgejo_id = ? AND status IS NULL",
  );
  const updateStmt = db.prepare(
    "UPDATE doc_map SET status = ? WHERE workspace_slug = ? AND cosheaf_id = ? AND forgejo_id = ? AND status IS NULL",
  );
  for (const row of missing) {
    if (!checkStillNull.get(workspaceSlug, row.cosheaf_id, row.forgejo_id)) {
      continue;
    }
    try {
      const raw = await backend.getRawFile(owner, repo, "main", row.forgejo_id);
      const { frontmatter } = parseFrontmatterYaml(raw);
      const status = normalizeTheoremStatus(frontmatter.status);
      updateStmt.run(status, workspaceSlug, row.cosheaf_id, row.forgejo_id);
    } catch (_err) {
      // Keep null if raw file cannot be read right now
    }
  }
}

export function workspaceTheoremValidation(
  db: Database.Database,
  workspaceSlug: string,
): { tainted_refs: TaintedReference[]; cyclic_refs: CyclicReference[] } {
  const docs = db
    .prepare(
      `SELECT cosheaf_id, forgejo_id, title, COALESCE(status, 'proved') AS status
         FROM doc_map
        WHERE workspace_slug = ?`,
    )
    .all(workspaceSlug) as Array<{
    cosheaf_id: string;
    forgejo_id: string;
    title: string | null;
    status: TheoremStatus;
  }>;

  const docById = new Map(docs.map((d) => [d.cosheaf_id, d]));
  const docByPath = new Map(docs.map((d) => [d.forgejo_id, d]));

  const xrefs = db
    .prepare("SELECT target_id, source_path FROM xref_targets WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ target_id: string; source_path: string }>;

  const sameFileDups = db
    .prepare("SELECT target_id FROM xref_target_duplicates WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ target_id: string }>;

  const localXrefsByPath = new Map<string, Set<string>>();
  for (const x of xrefs) {
    let set = localXrefsByPath.get(x.source_path);
    if (!set) {
      set = new Set<string>();
      localXrefsByPath.set(x.source_path, set);
    }
    set.add(x.target_id);
  }

  const duplicateXrefIds = new Set(sameFileDups.map((d) => d.target_id));
  const xrefCounts = new Map<string, number>();
  for (const x of xrefs) {
    xrefCounts.set(x.target_id, (xrefCounts.get(x.target_id) ?? 0) + 1);
  }

  const docByXref = new Map<string, (typeof docs)[number]>();
  for (const x of xrefs) {
    if (duplicateXrefIds.has(x.target_id)) continue;
    const count = xrefCounts.get(x.target_id) ?? 0;
    if (count === 1) {
      const doc = docByPath.get(x.source_path);
      if (doc) {
        docByXref.set(x.target_id, doc);
      }
    }
  }

  const links = db
    .prepare(
      `SELECT src_id, src_path, target_id, target_label, line
         FROM backlinks
        WHERE workspace_slug = ? AND target_id IS NOT NULL
        ORDER BY src_path, line, target_label`,
    )
    .all(workspaceSlug) as Array<{
    src_id: string;
    src_path: string;
    target_id: string;
    target_label: string;
    line: number | null;
  }>;

  function resolveTargetDoc(
    srcDoc: (typeof docs)[number] | undefined,
    link: (typeof links)[number],
  ): (typeof docs)[number] | null {
    if (
      srcDoc &&
      link.target_label.startsWith("[@") &&
      localXrefsByPath.get(srcDoc.forgejo_id)?.has(link.target_id) === true
    ) {
      return srcDoc;
    }
    return docById.get(link.target_id) ?? docByXref.get(link.target_id) ?? null;
  }

  const adj = new Map<string, Set<string>>();
  for (const doc of docs) {
    adj.set(doc.cosheaf_id, new Set<string>());
  }
  for (const link of links) {
    const srcDoc = docById.get(link.src_id) ?? docByPath.get(link.src_path);
    const targetDoc = resolveTargetDoc(srcDoc, link);
    if (srcDoc && targetDoc && srcDoc.cosheaf_id !== targetDoc.cosheaf_id) {
      let neighbors = adj.get(srcDoc.cosheaf_id);
      if (!neighbors) {
        neighbors = new Set<string>();
        adj.set(srcDoc.cosheaf_id, neighbors);
      }
      neighbors.add(targetDoc.cosheaf_id);
    }
  }

  const sortedAdj = new Map<string, string[]>();
  for (const [nodeId, neighbors] of adj) {
    sortedAdj.set(
      nodeId,
      Array.from(neighbors).sort((a, b) => {
        const pathA = docById.get(a)?.forgejo_id ?? a;
        const pathB = docById.get(b)?.forgejo_id ?? b;
        return pathA.localeCompare(pathB);
      }),
    );
  }

  const revAdj = new Map<string, string[]>();
  for (const doc of docs) {
    revAdj.set(doc.cosheaf_id, []);
  }
  for (const [nodeId, neighbors] of sortedAdj) {
    for (const w of neighbors) {
      let list = revAdj.get(w);
      if (!list) {
        list = [];
        revAdj.set(w, list);
      }
      list.push(nodeId);
    }
  }

  const unprovedDocs = docs
    .filter((d) => d.status !== "proved")
    .sort((a, b) => a.forgejo_id.localeCompare(b.forgejo_id));

  const distToTaint = new Map<string, number>();
  const nextHopToTaint = new Map<string, string>();
  const nearestTaintDoc = new Map<string, (typeof docs)[number]>();

  if (unprovedDocs.length > 0) {
    const revQueue: string[] = [];
    for (const u of unprovedDocs) {
      revQueue.push(u.cosheaf_id);
      distToTaint.set(u.cosheaf_id, 0);
      nearestTaintDoc.set(u.cosheaf_id, u);
    }

    let rHead = 0;
    while (rHead < revQueue.length) {
      const curr = revQueue[rHead];
      rHead += 1;
      if (curr === undefined) continue;

      const currDist = distToTaint.get(curr) ?? 0;
      for (const prev of revAdj.get(curr) ?? []) {
        if (!distToTaint.has(prev)) {
          distToTaint.set(prev, currDist + 1);
          revQueue.push(prev);
        }
      }
    }

    for (let i = unprovedDocs.length; i < revQueue.length; i++) {
      const nodeId = revQueue[i];
      if (nodeId === undefined) continue;
      const targetDist = (distToTaint.get(nodeId) ?? 0) - 1;
      const neighbors = sortedAdj.get(nodeId) ?? [];
      for (const w of neighbors) {
        if (distToTaint.get(w) === targetDist) {
          nextHopToTaint.set(nodeId, w);
          const target = nearestTaintDoc.get(w);
          if (target) {
            nearestTaintDoc.set(nodeId, target);
          }
          break;
        }
      }
    }
  }

  const taintedRefs: TaintedReference[] = [];

  function findNearestTainted(
    startDocId: string,
    originDocId: string,
  ): { targetDoc: (typeof docs)[number]; viaPath: string[] } | null {
    const startDoc = docById.get(startDocId);
    if (startDoc === undefined) return null;

    const queue: string[] = [startDocId];
    const visited = new Set<string>([startDocId, originDocId]);
    const parent = new Map<string, string>();
    let head = 0;

    while (head < queue.length) {
      const currentId = queue[head];
      head += 1;
      if (currentId === undefined) continue;

      const neighbors = sortedAdj.get(currentId) ?? [];
      for (const nextId of neighbors) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        parent.set(nextId, currentId);

        const nextDoc = docById.get(nextId);
        if (nextDoc === undefined) continue;

        if (nextDoc.status !== "proved") {
          const viaPath: string[] = [];
          let curr: string | undefined = nextId;
          while (curr !== undefined) {
            viaPath.push(docById.get(curr)?.forgejo_id ?? curr);
            if (curr === startDocId) break;
            curr = parent.get(curr);
          }
          viaPath.reverse();
          return { targetDoc: nextDoc, viaPath };
        }

        queue.push(nextId);
      }
    }

    return null;
  }

  for (const link of links) {
    const srcDoc = docById.get(link.src_id) ?? docByPath.get(link.src_path);
    if (!srcDoc || srcDoc.status !== "proved") continue;

    const directDoc = resolveTargetDoc(srcDoc, link);
    if (!directDoc || directDoc.cosheaf_id === srcDoc.cosheaf_id) continue;

    if (directDoc.status !== "proved") {
      taintedRefs.push({
        source_id: srcDoc.cosheaf_id,
        source_path: srcDoc.forgejo_id,
        source_title: srcDoc.title,
        target_id: directDoc.cosheaf_id,
        target_path: directDoc.forgejo_id,
        target_status: directDoc.status,
        target_label: link.target_label,
        line: link.line,
      });
    } else {
      if (!nearestTaintDoc.has(directDoc.cosheaf_id)) {
        continue;
      }
      const preTarget = nearestTaintDoc.get(directDoc.cosheaf_id);
      let tainted: { targetDoc: (typeof docs)[number]; viaPath: string[] } | null = null;
      if (preTarget) {
        const viaPath: string[] = [];
        let passThroughSrc = false;
        let curr: string | undefined = directDoc.cosheaf_id;
        const visitedInPath = new Set<string>();

        while (curr !== undefined) {
          if (curr === srcDoc.cosheaf_id) {
            passThroughSrc = true;
            break;
          }
          if (visitedInPath.has(curr)) {
            passThroughSrc = true;
            break;
          }
          visitedInPath.add(curr);
          viaPath.push(docById.get(curr)?.forgejo_id ?? curr);
          if (curr === preTarget.cosheaf_id) {
            break;
          }
          curr = nextHopToTaint.get(curr);
        }

        if (!passThroughSrc && curr === preTarget.cosheaf_id) {
          tainted = { targetDoc: preTarget, viaPath };
        }
      }

      if (!tainted) {
        tainted = findNearestTainted(directDoc.cosheaf_id, srcDoc.cosheaf_id);
      }

      if (tainted) {
        taintedRefs.push({
          source_id: srcDoc.cosheaf_id,
          source_path: srcDoc.forgejo_id,
          source_title: srcDoc.title,
          target_id: tainted.targetDoc.cosheaf_id,
          target_path: tainted.targetDoc.forgejo_id,
          target_status: tainted.targetDoc.status,
          target_label: link.target_label,
          line: link.line,
          via_path: tainted.viaPath,
        });
      }
    }
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const sortedDocIds = docs
    .slice()
    .sort((a, b) => a.forgejo_id.localeCompare(b.forgejo_id))
    .map((d) => d.cosheaf_id);

  for (const rootId of sortedDocIds) {
    if (!indices.has(rootId)) {
      indices.set(rootId, index);
      lowlink.set(rootId, index);
      index += 1;
      stack.push(rootId);
      onStack.set(rootId, true);

      const callStack: TarjanFrame[] = [
        {
          nodeId: rootId,
          neighbors: sortedAdj.get(rootId) ?? [],
          neighborIndex: 0,
        },
      ];

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1];
        if (frame === undefined) break;

        if (frame.neighborIndex < frame.neighbors.length) {
          const w = frame.neighbors[frame.neighborIndex];
          frame.neighborIndex += 1;
          if (w === undefined) continue;

          if (!indices.has(w)) {
            indices.set(w, index);
            lowlink.set(w, index);
            index += 1;
            stack.push(w);
            onStack.set(w, true);
            callStack.push({
              nodeId: w,
              neighbors: sortedAdj.get(w) ?? [],
              neighborIndex: 0,
            });
          } else if (onStack.get(w) === true) {
            const currentLow = lowlink.get(frame.nodeId) ?? 0;
            const neighborIndex = indices.get(w) ?? 0;
            lowlink.set(frame.nodeId, Math.min(currentLow, neighborIndex));
          }
        } else {
          callStack.pop();
          if (callStack.length > 0) {
            const parentFrame = callStack[callStack.length - 1];
            if (parentFrame !== undefined) {
              const parentLow = lowlink.get(parentFrame.nodeId) ?? 0;
              const frameLow = lowlink.get(frame.nodeId) ?? 0;
              lowlink.set(parentFrame.nodeId, Math.min(parentLow, frameLow));
            }
          }
          if (lowlink.get(frame.nodeId) === indices.get(frame.nodeId)) {
            const scc: string[] = [];
            while (true) {
              const popped = stack.pop();
              if (popped === undefined) break;
              onStack.set(popped, false);
              scc.push(popped);
              if (popped === frame.nodeId) break;
            }
            sccs.push(scc);
          }
        }
      }
    }
  }

  const cyclicRefs: CyclicReference[] = [];
  for (const scc of sccs) {
    if (scc.length > 1) {
      const sccDocs = scc
        .map((id) => docById.get(id))
        .filter((d): d is (typeof docs)[number] => d !== undefined)
        .sort((a, b) => a.forgejo_id.localeCompare(b.forgejo_id));
      cyclicRefs.push({
        cycle_ids: sccDocs.map((d) => d.cosheaf_id),
        cycle_paths: sccDocs.map((d) => d.forgejo_id),
      });
    }
  }

  cyclicRefs.sort((a, b) => (a.cycle_paths[0] ?? "").localeCompare(b.cycle_paths[0] ?? ""));

  return { tainted_refs: taintedRefs, cyclic_refs: cyclicRefs };
}

// These three reads are validation-only: they correlate backlinks against
// doc_map / xref_targets / citation_targets (broken refs), doc_map against
// backlinks (orphan labels), and xref_targets against xref_target_duplicates
// (duplicate xrefs). They have no other caller, so — unlike the shared
// autocomplete/resolve/backlinks reads in page-search.ts — moving them there
// would not remove any duplicated schema-shape knowledge; they stay here.
export function workspaceValidation(
  db: Database.Database,
  workspaceSlug: string,
): WorkspaceValidation {
  const brokenRefs = db
    .prepare(
      `SELECT b.src_id AS source_id,
              b.src_path AS source_path,
              src.title AS source_title,
              b.target_id AS target_id,
              b.target_label AS target_label,
              b.line AS line
         FROM backlinks b
         LEFT JOIN doc_map src
           ON src.workspace_slug = b.workspace_slug
          AND src.cosheaf_id = b.src_id
        WHERE b.workspace_slug = ?
          AND (
            b.target_id IS NULL
            OR (
              NOT EXISTS (
                SELECT 1 FROM doc_map target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.cosheaf_id = b.target_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM xref_targets target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.target_id = b.target_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM citation_targets target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.target_id = b.target_id
              )
            )
          )
        ORDER BY b.src_path, b.line, b.target_label`,
    )
    .all(workspaceSlug) as WorkspaceValidation["broken_refs"];
  const orphanLabels = db
    .prepare(
      `SELECT d.cosheaf_id AS id,
              d.forgejo_id AS path,
              d.title AS title
         FROM doc_map d
         LEFT JOIN backlinks b
           ON b.workspace_slug = d.workspace_slug
          AND b.target_id = d.cosheaf_id
          AND b.src_id != d.cosheaf_id
        WHERE d.workspace_slug = ?
          AND b.src_id IS NULL
        ORDER BY d.forgejo_id`,
    )
    .all(workspaceSlug) as WorkspaceValidation["orphan_labels"];
  const duplicateXrefs = db
    .prepare(
      `SELECT id, group_concat(path_note, ', ') AS paths, sum(count) AS count
         FROM (
           SELECT target_id AS id, source_path AS path_note, 1 AS count
             FROM xref_targets
            WHERE workspace_slug = ?
              AND NOT EXISTS (
                SELECT 1 FROM xref_target_duplicates duplicate
                 WHERE duplicate.workspace_slug = xref_targets.workspace_slug
                   AND duplicate.target_id = xref_targets.target_id
                   AND duplicate.source_path = xref_targets.source_path
              )
            UNION ALL
            SELECT target_id AS id, source_path || ' (' || count || ' definitions)' AS path_note, count
              FROM xref_target_duplicates
             WHERE workspace_slug = ?
          )
         GROUP BY id
        HAVING sum(count) > 1
         ORDER BY id`,
    )
    .all(workspaceSlug, workspaceSlug) as WorkspaceValidation["duplicate_xrefs"];

  const { tainted_refs, cyclic_refs } = workspaceTheoremValidation(db, workspaceSlug);

  return {
    broken_refs: brokenRefs,
    duplicate_xrefs: duplicateXrefs,
    orphan_labels: orphanLabels,
    ...(tainted_refs.length > 0 ? { tainted_refs } : {}),
    ...(cyclic_refs.length > 0 ? { cyclic_refs } : {}),
  };
}
