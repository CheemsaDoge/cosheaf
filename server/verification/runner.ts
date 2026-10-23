import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import {
  parseVerifySpecs,
  type VerifierKind,
  type VerifySpec,
} from "../../shared/theorem-status.js";

export type VerificationStatus = "pass" | "fail" | "skipped" | "error";

export interface VerificationResult {
  docPath: string;
  kind: VerifierKind;
  status: VerificationStatus;
  command: string[];
  exitCode: number | null;
  durationMs: number;
  message: string;
  alignment?: "not_checked";
}

export function hasBinary(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch (_err) {
    return false;
  }
}

function resolveSafePath(workspaceRoot: string, targetPath?: string): string | null {
  if (!targetPath || targetPath.trim() === "") {
    return null;
  }
  const rootAbs = path.resolve(workspaceRoot);
  const resolved = path.resolve(rootAbs, targetPath.trim());
  const rel = path.relative(rootAbs, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

export function runVerifySpec(
  workspaceRoot: string,
  docPath: string,
  spec: VerifySpec,
): VerificationResult {
  const startTime = Date.now();
  const timeout = spec.timeoutMs ?? 30_000;

  if (spec.kind === "python") {
    if (!spec.script) {
      return {
        docPath,
        kind: "python",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "Missing script in python verify spec",
      };
    }
    const scriptAbs = resolveSafePath(workspaceRoot, spec.script);
    if (!scriptAbs || !fs.existsSync(scriptAbs)) {
      return {
        docPath,
        kind: "python",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: `Python script not found or outside workspace: ${spec.script}`,
      };
    }

    const docAbs = path.resolve(workspaceRoot, docPath);
    const command = ["python3", scriptAbs, docAbs];

    if (!hasBinary("python3")) {
      return {
        docPath,
        kind: "python",
        status: "skipped",
        command,
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "python3 not found in PATH",
      };
    }

    const res = spawnSync("python3", [scriptAbs, docAbs], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout,
    });

    if (res.error) {
      return {
        docPath,
        kind: "python",
        status: "error",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: res.error.message,
      };
    }

    const pass = res.status === 0;
    return {
      docPath,
      kind: "python",
      status: pass ? "pass" : "fail",
      command,
      exitCode: res.status,
      durationMs: Date.now() - startTime,
      message: pass
        ? (res.stdout?.trim() || "Python verification passed")
        : (res.stderr?.trim() || res.stdout?.trim() || `Python exited with code ${res.status}`),
    };
  }

  if (spec.kind === "sat") {
    if (!spec.file) {
      return {
        docPath,
        kind: "sat",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "Missing file in sat verify spec",
      };
    }
    const fileAbs = resolveSafePath(workspaceRoot, spec.file);
    if (!fileAbs || !fs.existsSync(fileAbs)) {
      return {
        docPath,
        kind: "sat",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: `SAT file not found or outside workspace: ${spec.file}`,
      };
    }

    const command = ["kissat", fileAbs];
    if (!hasBinary("kissat")) {
      return {
        docPath,
        kind: "sat",
        status: "skipped",
        command,
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "kissat not found in PATH",
      };
    }

    const res = spawnSync("kissat", [fileAbs], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout,
    });

    if (res.error) {
      return {
        docPath,
        kind: "sat",
        status: "error",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: res.error.message,
      };
    }

    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    let actual: "sat" | "unsat" | null = null;
    if (output.includes("s SATISFIABLE") || res.status === 10) {
      actual = "sat";
    } else if (output.includes("s UNSATISFIABLE") || res.status === 20) {
      actual = "unsat";
    }

    if (!actual) {
      return {
        docPath,
        kind: "sat",
        status: "fail",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message:
          res.stderr?.trim() ||
          res.stdout?.trim() ||
          `Unknown kissat output with code ${res.status}`,
      };
    }

    if (spec.expect) {
      const pass = actual === spec.expect;
      return {
        docPath,
        kind: "sat",
        status: pass ? "pass" : "fail",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: pass
          ? `SAT check passed (actual: ${actual})`
          : `SAT check failed (expected: ${spec.expect}, actual: ${actual})`,
      };
    }

    return {
      docPath,
      kind: "sat",
      status: "pass",
      command,
      exitCode: res.status,
      durationMs: Date.now() - startTime,
      message: `SAT check passed (actual: ${actual})`,
    };
  }

  if (spec.kind === "smt") {
    if (!spec.file) {
      return {
        docPath,
        kind: "smt",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "Missing file in smt verify spec",
      };
    }
    const fileAbs = resolveSafePath(workspaceRoot, spec.file);
    if (!fileAbs || !fs.existsSync(fileAbs)) {
      return {
        docPath,
        kind: "smt",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: `SMT file not found or outside workspace: ${spec.file}`,
      };
    }

    const command = ["z3", "-smt2", fileAbs];
    if (!hasBinary("z3")) {
      return {
        docPath,
        kind: "smt",
        status: "skipped",
        command,
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "z3 not found in PATH",
      };
    }

    const res = spawnSync("z3", ["-smt2", fileAbs], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout,
    });

    if (res.error) {
      return {
        docPath,
        kind: "smt",
        status: "error",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: res.error.message,
      };
    }

    const stdoutLines = (res.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const firstLine = stdoutLines[0]?.toLowerCase() ?? "";

    let actual: "sat" | "unsat" | null = null;
    if (firstLine === "sat" || firstLine === "unsat") {
      actual = firstLine;
    }

    if (!actual) {
      return {
        docPath,
        kind: "smt",
        status: "fail",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message:
          res.stderr?.trim() ||
          res.stdout?.trim() ||
          `Unexpected z3 output: ${firstLine || "(empty)"}`,
      };
    }

    if (spec.expect) {
      const pass = actual === spec.expect;
      return {
        docPath,
        kind: "smt",
        status: pass ? "pass" : "fail",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: pass
          ? `SMT check passed (actual: ${actual})`
          : `SMT check failed (expected: ${spec.expect}, actual: ${actual})`,
      };
    }

    const pass = res.status === 0;
    return {
      docPath,
      kind: "smt",
      status: pass ? "pass" : "fail",
      command,
      exitCode: res.status,
      durationMs: Date.now() - startTime,
      message: pass
        ? `SMT check passed (actual: ${actual})`
        : (res.stderr?.trim() || `SMT check failed with exit code ${res.status}`),
    };
  }

  if (spec.kind === "lean") {
    if (!hasBinary("lean")) {
      return {
        docPath,
        kind: "lean",
        status: "skipped",
        command: ["lean"],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "lean not found in PATH",
        alignment: "not_checked",
      };
    }

    if (spec.file) {
      const fileAbs = resolveSafePath(workspaceRoot, spec.file);
      if (!fileAbs || !fs.existsSync(fileAbs)) {
        return {
          docPath,
          kind: "lean",
          status: "error",
          command: [],
          exitCode: null,
          durationMs: Date.now() - startTime,
          message: `Lean file not found or outside workspace: ${spec.file}`,
          alignment: "not_checked",
        };
      }

      const command = ["lean", fileAbs];
      const res = spawnSync("lean", [fileAbs], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout,
      });

      if (res.error) {
        return {
          docPath,
          kind: "lean",
          status: "error",
          command,
          exitCode: res.status,
          durationMs: Date.now() - startTime,
          message: res.error.message,
          alignment: "not_checked",
        };
      }

      const pass = res.status === 0;
      return {
        docPath,
        kind: "lean",
        status: pass ? "pass" : "fail",
        command,
        exitCode: res.status,
        durationMs: Date.now() - startTime,
        message: pass
          ? (res.stdout?.trim() || "Lean verification passed")
          : (res.stderr?.trim() || res.stdout?.trim() || `Lean exited with code ${res.status}`),
        alignment: "not_checked",
      };
    }

    if (spec.symbol) {
      let tmpDir: string | null = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-verify-"));
        const probeFile = path.join(tmpDir, "Probe.lean");
        fs.writeFileSync(probeFile, `#check ${spec.symbol}\n`, "utf8");
        const command = ["lean", probeFile];
        const res = spawnSync("lean", [probeFile], {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout,
        });

        if (res.error) {
          return {
            docPath,
            kind: "lean",
            status: "error",
            command,
            exitCode: res.status,
            durationMs: Date.now() - startTime,
            message: res.error.message,
            alignment: "not_checked",
          };
        }

        const pass = res.status === 0;
        return {
          docPath,
          kind: "lean",
          status: pass ? "pass" : "fail",
          command,
          exitCode: res.status,
          durationMs: Date.now() - startTime,
          message: pass
            ? (res.stdout?.trim() || "Lean symbol check passed")
            : (res.stderr?.trim() ||
              res.stdout?.trim() ||
              `Lean symbol check failed with code ${res.status}`),
          alignment: "not_checked",
        };
      } finally {
        if (tmpDir) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (_err) {
            // ignore cleanup error
          }
        }
      }
    }

    return {
      docPath,
      kind: "lean",
      status: "error",
      command: [],
      exitCode: null,
      durationMs: Date.now() - startTime,
      message: "Neither file nor symbol specified in lean verify spec",
      alignment: "not_checked",
    };
  }

  return {
    docPath,
    kind: spec.kind,
    status: "error",
    command: [],
    exitCode: null,
    durationMs: Date.now() - startTime,
    message: `Unsupported verifier kind: ${String(spec.kind)}`,
  };
}

export function verifyDocumentContent(
  workspaceRoot: string,
  docPath: string,
  content: string,
): VerificationResult[] {
  const parsed = parseFrontmatterYaml(content);
  const specs = parseVerifySpecs(parsed.frontmatter.verify);
  return specs.map((spec) => runVerifySpec(workspaceRoot, docPath, spec));
}
