import type { Hono } from "hono";
import type { WorkspaceValidation } from "../../shared/validation.js";
import type { AppEnv } from "../types.js";
import { ensureWorkspaceStatusesBackfilled, workspaceValidation } from "../workspace-validation.js";
import { htmlResponse, repoHref, urlPath, webRoute } from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { repoPageShell } from "./web-page.js";

export function registerDiagnosticsRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/diagnostics", webRoute(async (_c, ctx) => {
    await ensureWorkspaceStatusesBackfilled(ctx.db, ctx.backend, ctx.owner, ctx.repo, ctx.ws.slug);
    const validation = workspaceValidation(ctx.db, ctx.ws.slug);
    return htmlResponse(
      repoPageShell(ctx, "diagnostics", `Diagnostics - ${ctx.repo}`, html`
        <div class="page-title compact">
          <div>
            <h1>Diagnostics</h1>
            <p class="muted">Main-branch reference checks for Coflat pages.</p>
          </div>
        </div>
        ${diagnosticsSummary(validation)}
        ${brokenRefsSection(ctx.owner, ctx.repo, validation)}
        ${duplicateXrefsSection(ctx.owner, ctx.repo, validation)}
        ${orphanLabelsSection(ctx.owner, ctx.repo, validation)}
      `),
    );
  }));
}

function diagnosticsSummary(validation: WorkspaceValidation): Html {
  const total = validation.broken_refs.length + validation.duplicate_xrefs.length;
  return html`<section class="diagnostics-summary" data-testid="diagnostics-summary">
    <div>
      <strong>${total}</strong>
      <span>actionable</span>
    </div>
    <div>
      <strong>${validation.broken_refs.length}</strong>
      <span>broken references</span>
    </div>
    <div>
      <strong>${validation.duplicate_xrefs.length}</strong>
      <span>duplicate labels</span>
    </div>
    <div>
      <strong>${validation.orphan_labels.length}</strong>
      <span>unreferenced page ids</span>
    </div>
  </section>`;
}

function brokenRefsSection(owner: string, repo: string, validation: WorkspaceValidation): Html {
  return diagnosticsSection(
    "Broken References",
    "Links and cross-references whose targets are not indexed on main.",
    validation.broken_refs.length === 0
      ? emptyDiagnostics("No broken references.")
      : html`<div class="list" data-testid="diagnostics-broken-refs">
          ${validation.broken_refs.map((ref) => html`
            <div class="list-row diagnostics-row">
              <span class="list-row-main">
                <strong>${ref.target_id ?? ref.target_label}</strong>
                <small>${ref.target_label}${ref.line ? html` on line ${ref.line}` : emptyHtml}</small>
              </span>
              <a href="${sourceHref(owner, repo, ref.source_path, ref.line)}">${ref.source_title ?? ref.source_path}</a>
            </div>
          `)}
        </div>`,
  );
}

function duplicateXrefsSection(owner: string, repo: string, validation: WorkspaceValidation): Html {
  return diagnosticsSection(
    "Duplicate Labels",
    "Theorem, equation, heading, or block labels that resolve ambiguously.",
    validation.duplicate_xrefs.length === 0
      ? emptyDiagnostics("No duplicate labels.")
      : html`<div class="list" data-testid="diagnostics-duplicate-xrefs">
          ${validation.duplicate_xrefs.map((xref) => html`
            <div class="list-row diagnostics-row">
              <span class="list-row-main">
                <strong>${xref.id}</strong>
                <small>${xref.count} definitions</small>
              </span>
              <span>${pathsList(owner, repo, xref.paths)}</span>
            </div>
          `)}
        </div>`,
  );
}

function orphanLabelsSection(owner: string, repo: string, validation: WorkspaceValidation): Html {
  return diagnosticsSection(
    "Unreferenced Page Ids",
    "Informational only: these page ids are not referenced by another page on main.",
    validation.orphan_labels.length === 0
      ? emptyDiagnostics("Every page id is referenced by another page.")
      : html`<div class="list" data-testid="diagnostics-orphan-labels">
          ${validation.orphan_labels.map((label) => html`
            <a class="list-row diagnostics-row" href="${readHref(owner, repo, label.path)}">
              <span class="list-row-main">
                <strong>${label.title ?? label.id}</strong>
                <small>${label.id}</small>
              </span>
              <small>${label.path}</small>
            </a>
          `)}
        </div>`,
  );
}

function diagnosticsSection(title: string, description: string, body: Html): Html {
  return html`<section class="settings-section diagnostics-section">
    <div class="settings-section-header">
      <h2>${title}</h2>
      <p>${description}</p>
    </div>
    <div>${body}</div>
  </section>`;
}

function emptyDiagnostics(message: string): Html {
  return html`<div class="empty">${message}</div>`;
}

function readHref(owner: string, repo: string, path: string): string {
  return `${repoHref(owner, repo, "/src/branch/main")}/${urlPath(path)}`;
}

function sourceHref(owner: string, repo: string, path: string, line: number | null): string {
  const hash = line ? `#L${line}` : "";
  return `${readHref(owner, repo, path)}?view=source${hash}`;
}

function pathsList(owner: string, repo: string, paths: string): Html {
  return html`${paths.split(", ").map((path, index) => {
    const clean = path.replace(/ \(\d+ definitions\)$/, "");
    return html`${index > 0 ? ", " : ""}<a href="${readHref(owner, repo, clean)}">${path}</a>`;
  })}`;
}
