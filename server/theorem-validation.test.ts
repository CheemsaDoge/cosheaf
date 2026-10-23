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
  return freshTestDb("cosheaf-thm-");
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
});
