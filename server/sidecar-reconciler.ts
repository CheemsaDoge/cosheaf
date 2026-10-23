import type Database from "better-sqlite3";
import { documentFormatFromTopics } from "../shared/document-format.js";
import type { Forgejo } from "./forgejo.js";
import { listVisibleWorkspaceRepos } from "./workspace-discovery.js";
import { lockedReindexWorkspaceFromForgejo } from "./workspace-provisioning.js";
import { serializeWorkspace } from "./workspace-queue.js";

export interface ReconcileWorkspaceResult {
  slug: string;
  status: "reindexed" | "skipped" | "failed";
  pages: number;
  detail: string;
}

export async function reconcileAllCoflatWorkspaces(
  db: Database.Database,
  forgejo: Forgejo,
): Promise<ReconcileWorkspaceResult[]> {
  const repos = await listVisibleWorkspaceRepos(forgejo);
  const results: ReconcileWorkspaceResult[] = [];
  for (const repo of repos) {
    const formatId = documentFormatFromTopics(repo.topics ?? []);
    try {
      const pages = await serializeWorkspace(repo.full_name, () =>
        lockedReindexWorkspaceFromForgejo(db, forgejo, {
          owner: repo.owner.login,
          repo: repo.name,
          slug: repo.full_name,
          defaultMdFormat: formatId,
        }),
      );
      results.push({
        slug: repo.full_name,
        status: "reindexed",
        pages,
        detail: `${pages} markdown file${pages === 1 ? "" : "s"}`,
      });
    } catch (err) {
      results.push({
        slug: repo.full_name,
        status: "failed",
        pages: 0,
        detail: (err as Error).message,
      });
    }
  }
  return results;
}

export function summarizeReconcileResults(results: ReconcileWorkspaceResult[]): {
  reindexed: number;
  skipped: number;
  failed: number;
  pages: number;
} {
  return results.reduce(
    (summary, result) => {
      summary[result.status]++;
      summary.pages += result.pages;
      return summary;
    },
    { reindexed: 0, skipped: 0, failed: 0, pages: 0 },
  );
}

export function hasPendingStatusBackfill(db: Database.Database): boolean {
  const row = db.prepare("SELECT 1 FROM doc_map WHERE status IS NULL LIMIT 1").get();
  return Boolean(row);
}

export function startSidecarReconciler(options: {
  db: Database.Database;
  forgejo: Forgejo;
  intervalMs: number;
  log?: Pick<Console, "log" | "warn">;
}): NodeJS.Timeout | null {
  const { db, forgejo, intervalMs, log = console } = options;
  let running = false;
  const runOnce = async (): Promise<void> => {
    if (running) {
      log.warn("sidecar reconcile skipped: previous run still active");
      return;
    }
    running = true;
    try {
      const results = await reconcileAllCoflatWorkspaces(db, forgejo);
      const summary = summarizeReconcileResults(results);
      const failed = results.filter((result) => result.status === "failed");
      log.log(
        `sidecar reconcile: ${summary.reindexed} reindexed, ${summary.skipped} skipped, ${summary.pages} pages`,
      );
      for (const result of failed) {
        log.warn(`sidecar reconcile failed for ${result.slug}: ${result.detail}`);
      }
    } catch (err) {
      log.warn(`sidecar reconcile failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  if (hasPendingStatusBackfill(db)) {
    void runOnce();
  }
  if (intervalMs <= 0) return null;
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();
  return timer;
}
