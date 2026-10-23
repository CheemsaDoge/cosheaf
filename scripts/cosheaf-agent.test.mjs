import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  loadPrFiles,
  normalizeApiBase,
  parseFileSpec,
  parseWorkspace,
  prFromFiles,
  tokenFromOptions,
  verifyLocalWorkspace,
} from "./cosheaf-agent.mjs";

describe("cosheaf-agent", () => {
  it("parses owner/repo workspaces", () => {
    expect(parseWorkspace("chao/flushing-coin")).toEqual({
      owner: "chao",
      repo: "flushing-coin",
      slug: "chao/flushing-coin",
    });
    expect(() => parseWorkspace("flushing-coin")).toThrow("--workspace must be <owner>/<repo>");
  });

  it("parses file specs with optional local path mapping", () => {
    expect(parseFileSpec("notes/a.md")).toEqual({
      workspacePath: "notes/a.md",
      localPath: "notes/a.md",
    });
    expect(parseFileSpec("notes/a.md=/tmp/a.md")).toEqual({
      workspacePath: "notes/a.md",
      localPath: "/tmp/a.md",
    });
    expect(() => parseFileSpec("../secret.md")).toThrow("Invalid workspace path");
    expect(() => parseFileSpec("/secret.md")).toThrow("Invalid workspace path");
  });

  it("loads PR files through an injectable reader", () => {
    const files = loadPrFiles(["notes/a.md=local/a.md"], (path) => `read:${path}`);
    expect(files).toEqual([
      {
        workspacePath: "notes/a.md",
        localPath: "local/a.md",
        content: "read:local/a.md",
      },
    ]);
  });

  it("normalizes API URLs and token sources", () => {
    expect(normalizeApiBase("http://127.0.0.1:3030/api/v1/")).toBe("http://127.0.0.1:3030/api/v1");
    expect(tokenFromOptions({}, { COSHEAF_TOKEN: "token-1" })).toBe("token-1");
    expect(tokenFromOptions({}, { COSHEAF_PAT: "pat-1" })).toBe("pat-1");
    expect(tokenFromOptions({ token: "token-2" }, { COSHEAF_TOKEN: "token-1" })).toBe("token-2");
    expect(() => tokenFromOptions({}, {})).toThrow("A Cosheaf API token is required");
  });

  it("builds a dry-run PR plan without calling Cosheaf", async () => {
    const result = await prFromFiles({
      api: "http://127.0.0.1:3030/api/v1/",
      workspace: "chao/flushing-coin",
      branch: "agent/wip",
      base: "main",
      title: "Update notes",
      file: ["notes/a.md=docs/AI_CLIENTS.md"],
      dryRun: true,
    });
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      api: "http://127.0.0.1:3030/api/v1",
      workspace: "chao/flushing-coin",
      branch: "agent/wip",
      base: "main",
      title: "Update notes",
      files: [{ path: "notes/a.md", localPath: "docs/AI_CLIENTS.md" }],
    });
  });
});

describe("verifyLocalWorkspace", () => {
  it("detects Coflat markdown path links and cross-file theorem block refs to draft pages while ignoring escaped refs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-test-co-"));
    try {
      writeFileSync(
        path.join(dir, "pending.md"),
        `---
id: pending-doc
status: draft
---
# Pending

::: {#thm:pending .theorem}
Draft theorem.
:::
`,
        "utf8",
      );
      writeFileSync(
        path.join(dir, "via-path.md"),
        `---
id: via-path
status: proved
---
# Via Path

See [Pending](pending.md).
`,
        "utf8",
      );
      writeFileSync(
        path.join(dir, "via-xref.md"),
        `---
id: via-xref
status: proved
---
# Via Xref

By [@thm:pending], we have the bound.
`,
        "utf8",
      );
      writeFileSync(
        path.join(dir, "escaped.md"),
        `---
id: escaped
status: proved
---
# Escaped

Escaped \\[@pending-doc] and inline code \`[@thm:pending]\`.
`,
        "utf8",
      );

      const result = verifyLocalWorkspace({ dir });
      expect(result.ok).toBe(false);
      expect(
        result.tainted_refs.some(
          (t) =>
            t.source_path === "via-path.md" && t.target_path === "pending.md",
        ),
      ).toBe(true);
      expect(
        result.tainted_refs.some(
          (t) =>
            t.source_path === "via-xref.md" && t.target_path === "pending.md",
        ),
      ).toBe(true);
      expect(
        result.tainted_refs.some((t) => t.source_path === "escaped.md"),
      ).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("fails SAT verification when kissat only prints banner and exits with code 1 under expect: sat", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cosheaf-sat-"));
    const binDir = path.join(tmpDir, "bin");
    const workDir = path.join(tmpDir, "work");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const kissatScript = path.join(binDir, "kissat");
    writeFileSync(
      kissatScript,
      `#!/bin/sh\nprintf 'c Kissat SAT Solver\\nc error: cannot read file\\n'\nexit 1\n`,
      "utf8",
    );
    chmodSync(kissatScript, 0o755);

    writeFileSync(
      path.join(workDir, "doc.md"),
      `---
id: sat-test
status: proved
verify:
  - kind: sat
    file: test.cnf
    expect: sat
---
# SAT Test
`,
      "utf8",
    );
    writeFileSync(path.join(workDir, "test.cnf"), "", "utf8");

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${oldPath}`;
      const result = verifyLocalWorkspace({ dir: workDir });
      expect(result.ok).toBe(false);
      expect(result.verification_results[0].status).toBe("fail");
    } finally {
      process.env.PATH = oldPath;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("fails SMT verification when z3 prints sat but exits with non-zero code under expect: sat", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cosheaf-smt-"));
    const binDir = path.join(tmpDir, "bin");
    const workDir = path.join(tmpDir, "work");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const z3Script = path.join(binDir, "z3");
    writeFileSync(
      z3Script,
      `#!/bin/sh\nprintf 'sat\\n(error "check failed")\\n'\nexit 1\n`,
      "utf8",
    );
    chmodSync(z3Script, 0o755);

    writeFileSync(
      path.join(workDir, "doc.md"),
      `---
id: smt-test
status: proved
verify:
  - kind: smt
    file: test.smt2
    expect: sat
---
# SMT Test
`,
      "utf8",
    );
    writeFileSync(path.join(workDir, "test.smt2"), "", "utf8");

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${oldPath}`;
      const result = verifyLocalWorkspace({ dir: workDir });
      expect(result.ok).toBe(false);
      expect(result.verification_results[0].status).toBe("fail");
    } finally {
      process.env.PATH = oldPath;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("resolves document-local crossrefs before workspace page IDs without false taint", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "cosheaf-local-xref-"));
    try {
      writeFileSync(
        path.join(workDir, "a.md"),
        `---
id: a
status: proved
---
# Page A

## Local B {#b}

See [@b].
`,
        "utf8",
      );
      writeFileSync(
        path.join(workDir, "b.md"),
        `---
id: b
status: draft
---
# Draft Page B
`,
        "utf8",
      );

      const result = verifyLocalWorkspace({ dir: workDir });
      expect(result.ok).toBe(true);
      expect(result.tainted_refs).toEqual([]);
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("supports symbol-only Lean verify specifications", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cosheaf-lean-sym-"));
    const binDir = path.join(tmpDir, "bin");
    const workDir = path.join(tmpDir, "work");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const leanScript = path.join(binDir, "lean");
    writeFileSync(
      leanScript,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
target="$1"
if [ ! -f "$target" ]; then
  exit 1
fi
if grep -Fq '#check Nat.add' "$target"; then
  printf 'Nat.add : Nat -> Nat -> Nat\\n'
  exit 0
elif grep -Fq '#check MyProject.main' "$target"; then
  if grep -Fq 'import MyProject' "$target" || grep -Fq 'def main' "$target"; then
    printf 'MyProject.main : Nat\\n'
    exit 0
  else
    exit 1
  fi
else
  exit 1
fi
`,
      "utf8",
    );
    chmodSync(leanScript, 0o755);

    writeFileSync(
      path.join(workDir, "MyProject.lean"),
      `namespace MyProject
def main : Nat := 42
end MyProject
`,
      "utf8",
    );

    writeFileSync(
      path.join(workDir, "lean-sym.md"),
      `---
id: lean-sym
status: proved
verify:
  - kind: lean
    symbol: Nat.add
  - kind: lean
    symbol: MyProject.main
---
# Lean Symbol Test
`,
      "utf8",
    );

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${oldPath}`;
      const result = verifyLocalWorkspace({ dir: workDir });
      expect(result.ok).toBe(true);
      expect(result.verification_results).toHaveLength(2);
      expect(result.verification_results[0].status).toBe("pass");
      expect(result.verification_results[1].status).toBe("pass");
    } finally {
      process.env.PATH = oldPath;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("fails verification and reports cyclic_refs when proved documents form a dependency cycle", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "cosheaf-cycle-"));
    try {
      writeFileSync(
        path.join(workDir, "cycle-a.md"),
        `---
id: cycle-a
status: proved
---
# Cycle A

By [@cycle-b], A holds.
`,
        "utf8",
      );
      writeFileSync(
        path.join(workDir, "cycle-b.md"),
        `---
id: cycle-b
status: proved
---
# Cycle B

By [@cycle-a], B holds.
`,
        "utf8",
      );

      const result = verifyLocalWorkspace({ dir: workDir });
      expect(result.ok).toBe(false);
      expect(result.cyclic_refs).toHaveLength(1);
      expect(result.cyclic_refs[0].cycle_paths).toEqual(["cycle-a.md", "cycle-b.md"]);
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("fails verification when --dir points to a file instead of a directory", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "cosheaf-dir-file-"));
    try {
      const readmePath = path.join(workDir, "README.md");
      writeFileSync(readmePath, "# Readme\n", "utf8");

      const result = verifyLocalWorkspace({ dir: readmePath });
      expect(result.ok).toBe(false);
      expect(result.checked_files).toBe(0);
      expect(result.verification_results[0].status).toBe("error");
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });
});
