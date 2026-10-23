import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  normalizeTheoremStatus,
  parseVerifySpecs,
} from "../shared/theorem-status.js";
import { indexPageBatch } from "./indexer.js";
import { freshTestDb } from "./routes/test-fixtures.js";
import {
  runVerifySpec,
  verifyDocumentContent,
} from "./verification/runner.js";
import {
  workspaceTheoremValidation,
  workspaceValidation,
} from "./workspace-validation.js";

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-thm-");
  const retained: unknown[] = [];
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const stmt = originalPrepare(source);
    retained.push(stmt);
    return stmt;
  }) as typeof db.prepare;
  return db;
}

describe("normalizeTheoremStatus and parseVerifySpecs", () => {
  it("normalizes default, null, proved, and accepted to 'proved'", () => {
    expect(normalizeTheoremStatus(undefined)).toBe("proved");
    expect(normalizeTheoremStatus(null)).toBe("proved");
    expect(normalizeTheoremStatus("proved")).toBe("proved");
    expect(normalizeTheoremStatus("PROVED")).toBe("proved");
    expect(normalizeTheoremStatus("  proved  ")).toBe("proved");
    expect(normalizeTheoremStatus("accepted")).toBe("proved");
    expect(normalizeTheoremStatus("random_string")).toBe("proved");
  });

  it("normalizes draft, conjecture, and locally_tested to 'draft'", () => {
    expect(normalizeTheoremStatus("draft")).toBe("draft");
    expect(normalizeTheoremStatus("DRAFT")).toBe("draft");
    expect(normalizeTheoremStatus("conjecture")).toBe("draft");
    expect(normalizeTheoremStatus("raw")).toBe("draft");
    expect(normalizeTheoremStatus("locally_tested")).toBe("draft");
  });

  it("normalizes refuted and obsolete to 'refuted'", () => {
    expect(normalizeTheoremStatus("refuted")).toBe("refuted");
    expect(normalizeTheoremStatus("REFUTED")).toBe("refuted");
    expect(normalizeTheoremStatus("obsolete")).toBe("refuted");
  });

  it("parses valid verify specs and ignores invalid entries", () => {
    expect(parseVerifySpecs(null)).toEqual([]);
    expect(parseVerifySpecs(undefined)).toEqual([]);
    expect(parseVerifySpecs("not-an-array")).toEqual([]);

    const raw = [
      null,
      42,
      "string",
      { kind: "unsupported" },
      { kind: "python", script: "checks/run.py" },
      { kind: "sat", file: "checks/gate.cnf", expect: "unsat" },
      { kind: "smt", file: "checks/model.smt2", expect: "sat" },
      {
        kind: "lean",
        file: "checks/Proof.lean",
        symbol: "Theorem.main",
        timeoutMs: 15000,
      },
      { kind: "sat", expect: "invalid_expect" },
      { kind: "python", timeoutMs: -50 },
    ];

    const parsed = parseVerifySpecs(raw);
    expect(parsed).toEqual([
      { kind: "python", script: "checks/run.py" },
      { kind: "sat", file: "checks/gate.cnf", expect: "unsat" },
      { kind: "smt", file: "checks/model.smt2", expect: "sat" },
      {
        kind: "lean",
        file: "checks/Proof.lean",
        symbol: "Theorem.main",
        timeoutMs: 15000,
      },
      { kind: "sat" },
      { kind: "python" },
    ]);
  });
});

describe("direct and transitive dependency taint detection (tainted_refs)", () => {
  it("accurately detects direct and transitive tainted references to unproved targets", () => {
    const db = freshDb();

    const mainThmBody = [
      "---",
      "id: mainthm",
      "title: Main Theorem",
      "status: proved",
      "---",
      "# Main Theorem",
      "",
      "This theorem relies on [@lemma1].",
      "",
    ].join("\n");

    const lemma1Body = [
      "---",
      "id: lemma1",
      "title: Lemma 1",
      "status: proved",
      "---",
      "# Lemma 1",
      "",
      "This lemma reduces to [@thm:conj].",
      "",
    ].join("\n");

    const conjBody = [
      "---",
      "id: conj",
      "title: Unproved Conjecture",
      "status: draft",
      "---",
      "# Unproved Conjecture",
      "",
      "::: {#thm:conj .theorem}",
      "Unproved.",
      ":::",
      "",
    ].join("\n");

    indexPageBatch(db, "owner/w", [
      { path: "main-thm.md", body: mainThmBody },
      { path: "lemma1.md", body: lemma1Body },
      { path: "conj.md", body: conjBody },
    ]);

    const theoremValidation = workspaceTheoremValidation(db, "owner/w");
    expect(theoremValidation.tainted_refs).toHaveLength(2);

    const lemma1Taint = theoremValidation.tainted_refs.find(
      (r) => r.source_id === "lemma1" && r.source_path === "lemma1.md",
    );
    expect(lemma1Taint).toBeDefined();
    expect(lemma1Taint).toMatchObject({
      source_id: "lemma1",
      source_path: "lemma1.md",
      target_id: "conj",
      target_path: "conj.md",
      target_status: "draft",
      target_label: "[@thm:conj]",
    });
    expect(lemma1Taint?.via_path).toBeUndefined();

    const mainThmTaint = theoremValidation.tainted_refs.find(
      (r) => r.source_id === "mainthm" && r.source_path === "main-thm.md",
    );
    expect(mainThmTaint).toBeDefined();
    expect(mainThmTaint).toMatchObject({
      source_id: "mainthm",
      source_path: "main-thm.md",
      target_id: "conj",
      target_path: "conj.md",
      target_status: "draft",
      target_label: "[@lemma1]",
      via_path: ["lemma1.md", "conj.md"],
    });

    const fullValidation = workspaceValidation(db, "owner/w");
    expect(fullValidation.tainted_refs).toEqual(theoremValidation.tainted_refs);
  });
});

describe("cyclic reference detection (cyclic_refs)", () => {
  it("accurately detects circular reasoning between mutually referencing pages", () => {
    const db = freshDb();

    const aBody = [
      "---",
      "id: a",
      "title: Page A",
      "status: proved",
      "---",
      "# Page A",
      "",
      "Referencing [@b].",
      "",
    ].join("\n");

    const bBody = [
      "---",
      "id: b",
      "title: Page B",
      "status: proved",
      "---",
      "# Page B",
      "",
      "Referencing [@a].",
      "",
    ].join("\n");

    indexPageBatch(db, "owner/w", [
      { path: "a.md", body: aBody },
      { path: "b.md", body: bBody },
    ]);

    const theoremValidation = workspaceTheoremValidation(db, "owner/w");
    expect(theoremValidation.cyclic_refs).toHaveLength(1);
    expect(theoremValidation.cyclic_refs[0]).toEqual({
      cycle_ids: ["a", "b"],
      cycle_paths: ["a.md", "b.md"],
    });

    const fullValidation = workspaceValidation(db, "owner/w");
    expect(fullValidation.cyclic_refs).toEqual(theoremValidation.cyclic_refs);
  });

  it("handles a 4000-page acyclic reference chain without call stack overflow", () => {
    const db = freshDb();
    const count = 4000;

    const insertDoc = db.prepare(
      `INSERT INTO doc_map (workspace_slug, cosheaf_id, forgejo_id, title, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBacklink = db.prepare(
      `INSERT INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const seedChain = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const id = `page-${String(i).padStart(4, "0")}`;
        const pagePath = `${id}.md`;
        const status = i === count - 1 ? "draft" : "proved";
        insertDoc.run("owner/w", id, pagePath, `Page ${i}`, status, 1700000000);

        if (i < count - 1) {
          const nextId = `page-${String(i + 1).padStart(4, "0")}`;
          insertBacklink.run(
            "owner/w",
            id,
            pagePath,
            nextId,
            `[@${nextId}]`,
            1,
          );
        }
      }
    });

    seedChain();

    let theoremValidation: ReturnType<typeof workspaceTheoremValidation> | undefined;
    expect(() => {
      theoremValidation = workspaceTheoremValidation(db, "owner/w");
    }).not.toThrow();

    expect(theoremValidation?.cyclic_refs).toEqual([]);
    expect(theoremValidation?.tainted_refs).toHaveLength(3999);

    let fullValidation: ReturnType<typeof workspaceValidation> | undefined;
    expect(() => {
      fullValidation = workspaceValidation(db, "owner/w");
    }).not.toThrow();

    expect(fullValidation?.cyclic_refs ?? []).toEqual([]);
    expect(fullValidation?.tainted_refs).toHaveLength(3999);
  });
});

describe("executable verifiers (runVerifySpec & verifyDocumentContent)", () => {
  it("executes python checks and handles path traversal and missing external solvers safely", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cosheaf-runner-test-"));

    try {
      const checkOkPath = path.join(tmpDir, "check_ok.py");
      writeFileSync(checkOkPath, "import sys\nsys.exit(0)\n", "utf8");

      const checkFailPath = path.join(tmpDir, "check_fail.py");
      writeFileSync(checkFailPath, "import sys\nsys.exit(1)\n", "utf8");

      const dummyCnf = path.join(tmpDir, "dummy.cnf");
      writeFileSync(dummyCnf, "p cnf 1 1\n1 0\n", "utf8");

      const dummySmt = path.join(tmpDir, "dummy.smt2");
      writeFileSync(dummySmt, "(check-sat)\n", "utf8");

      const dummyLean = path.join(tmpDir, "dummy.lean");
      writeFileSync(dummyLean, "-- dummy lean\n", "utf8");

      const docContent = [
        "---",
        "id: doc1",
        "title: Runner Doc",
        "verify:",
        "  - kind: python",
        "    script: check_ok.py",
        "  - kind: python",
        "    script: check_fail.py",
        "---",
        "# Runner Doc",
        "",
      ].join("\n");

      const docPath = "doc.md";
      const docFile = path.join(tmpDir, docPath);
      writeFileSync(docFile, docContent, "utf8");

      const results = verifyDocumentContent(tmpDir, docPath, docContent);
      expect(results).toHaveLength(2);
      expect(results[0]?.status).toBe("pass");
      expect(results[0]?.kind).toBe("python");
      expect(results[1]?.status).toBe("fail");
      expect(results[1]?.kind).toBe("python");

      const traversalResult = runVerifySpec(tmpDir, docPath, {
        kind: "python",
        script: "../outside.py",
      });
      expect(traversalResult.status).toBe("error");

      const satResult = runVerifySpec(tmpDir, docPath, {
        kind: "sat",
        file: "dummy.cnf",
        expect: "sat",
      });
      expect(["skipped", "pass", "fail"]).toContain(satResult.status);

      const smtResult = runVerifySpec(tmpDir, docPath, {
        kind: "smt",
        file: "dummy.smt2",
        expect: "sat",
      });
      expect(["skipped", "pass", "fail"]).toContain(smtResult.status);

      const leanFileResult = runVerifySpec(tmpDir, docPath, {
        kind: "lean",
        file: "dummy.lean",
      });
      expect(["skipped", "pass", "fail"]).toContain(leanFileResult.status);

      const leanSymbolResult = runVerifySpec(tmpDir, docPath, {
        kind: "lean",
        symbol: "Nat.add",
      });
      expect(["skipped", "pass", "fail"]).toContain(leanSymbolResult.status);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });

  it("rejects SAT banner false positives and non-zero solver exit codes", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "cosheaf-solver-test-"));
    const originalPath = process.env.PATH;

    try {
      const kissatBin = path.join(tmpDir, "kissat");
      writeFileSync(
        kissatBin,
        '#!/bin/sh\nprintf "c Kissat SAT Solver\\nc error: invalid input\\n"\nexit 1\n',
        { mode: 0o755 },
      );

      const z3Bin = path.join(tmpDir, "z3");
      writeFileSync(
        z3Bin,
        '#!/bin/sh\nprintf "sat\\n(error \\"failed\\")\\n"\nexit 1\n',
        { mode: 0o755 },
      );

      const badCnf = path.join(tmpDir, "bad.cnf");
      writeFileSync(badCnf, "p cnf 1 1\n1 0\n", "utf8");

      const badSmt2 = path.join(tmpDir, "bad.smt2");
      writeFileSync(badSmt2, "(check-sat)\n", "utf8");

      process.env.PATH = `${tmpDir}${path.delimiter}${originalPath ?? ""}`;

      const satResult = runVerifySpec(tmpDir, "doc.md", {
        kind: "sat",
        file: "bad.cnf",
        expect: "sat",
      });
      expect(satResult.status).toBe("fail");

      const smtResult = runVerifySpec(tmpDir, "doc.md", {
        kind: "smt",
        file: "bad.smt2",
        expect: "sat",
      });
      expect(smtResult.status).toBe("fail");
    } finally {
      process.env.PATH = originalPath;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_err) {
        // cleanup ignore
      }
    }
  });
});
