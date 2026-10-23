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

const LEAN_PRELUDE_NAMESPACES = new Set([
  "Nat",
  "Int",
  "Bool",
  "List",
  "String",
  "Char",
  "Array",
  "Option",
  "Prod",
  "Sum",
  "Subtype",
  "Sigma",
  "Fin",
  "BitVec",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "USize",
  "Float",
  "IO",
  "Task",
  "Except",
  "EStateM",
  "StateT",
  "ReaderT",
  "Id",
  "Classical",
  "Function",
  "Decidable",
  "Eq",
  "Iff",
  "And",
  "Or",
  "Not",
  "Exists",
  "True",
  "False",
  "Empty",
  "Unit",
  "PUnit",
  "ULift",
  "PLift",
  "Lean",
  "Std",
]);

function scanLeanFiles(
  dir: string,
  baseDir: string,
  result: Array<{ relPath: string; absPath: string }>,
  maxDepth = 10,
): void {
  if (maxDepth <= 0) return;
  const IGNORE_DIRS = new Set([
    ".git",
    ".lake",
    "node_modules",
    "dist",
    ".cosheaf",
  ]);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        scanLeanFiles(
          path.join(dir, entry.name),
          baseDir,
          result,
          maxDepth - 1,
        );
      }
    } else if (entry.isFile() && entry.name.endsWith(".lean")) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, absPath);
      result.push({ relPath, absPath });
    }
  }
}

export function resolveWorkspaceLeanModules(
  workspaceRoot: string,
  symbol: string,
  explicitFile?: string,
): { modules: string[]; files: string[] } {
  const modulesSet = new Set<string>();
  const filesSet = new Set<string>();

  if (explicitFile) {
    const explicitAbs = resolveSafePath(workspaceRoot, explicitFile);
    if (explicitAbs && fs.existsSync(explicitAbs)) {
      const rel = path
        .relative(workspaceRoot, explicitAbs)
        .replace(/\\/g, "/");
      let modName = rel
        .replace(/\.lean$/i, "")
        .split("/")
        .filter(Boolean)
        .join(".");
      if (rel.startsWith("src/")) {
        const withoutSrc = rel
          .slice(4)
          .replace(/\.lean$/i, "")
          .split("/")
          .filter(Boolean)
          .join(".");
        if (symbol === withoutSrc || symbol.startsWith(`${withoutSrc}.`)) {
          modName = withoutSrc;
        }
      }
      if (modName) {
        modulesSet.add(modName);
      }
      filesSet.add(explicitAbs);
    }
  }

  const leanFiles: Array<{ relPath: string; absPath: string }> = [];
  scanLeanFiles(workspaceRoot, workspaceRoot, leanFiles);

  const shortName = symbol.split(".").pop() ?? symbol;
  const escapedShortName = shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRegex = new RegExp(
    `\\b(?:theorem|lemma|def|abbrev|inductive|structure|class|instance|axiom|opaque)\\s+${escapedShortName}(?:\\b|(?![\\w']))`,
  );

  for (const file of leanFiles) {
    const normalizedRel = file.relPath.replace(/\\/g, "/");
    let modName = normalizedRel
      .replace(/\.lean$/i, "")
      .split("/")
      .filter(Boolean)
      .join(".");
    if (normalizedRel.startsWith("src/")) {
      const withoutSrc = normalizedRel
        .slice(4)
        .replace(/\.lean$/i, "")
        .split("/")
        .filter(Boolean)
        .join(".");
      if (symbol === withoutSrc || symbol.startsWith(`${withoutSrc}.`)) {
        modName = withoutSrc;
      }
    }

    let matched = false;
    if (symbol.includes(".")) {
      if (symbol === modName || symbol.startsWith(`${modName}.`)) {
        matched = true;
      }
    }

    let content = "";
    try {
      content = fs.readFileSync(file.absPath, "utf8");
    } catch (_err) {
      content = "";
    }

    if (
      !matched &&
      (declRegex.test(content) || (symbol && content.includes(symbol)))
    ) {
      matched = true;
    }

    if (matched) {
      if (modName) {
        modulesSet.add(modName);
      }
      filesSet.add(file.absPath);
    }
  }

  if (modulesSet.size === 0 && filesSet.size === 0 && symbol.includes(".")) {
    const parts = symbol.split(".");
    const rootNs = parts[0] ?? "";
    if (rootNs && !LEAN_PRELUDE_NAMESPACES.has(rootNs)) {
      const modPrefix = parts.slice(0, -1).join(".");
      if (modPrefix) {
        modulesSet.add(modPrefix);
      }
    }
  }

  return {
    modules: Array.from(modulesSet),
    files: Array.from(filesSet),
  };
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

    const lines = (res.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
    let parsedLine: "sat" | "unsat" | null = null;
    for (const line of lines) {
      if (/^s\s+SATISFIABLE$/i.test(line)) {
        parsedLine = "sat";
        break;
      }
      if (/^s\s+UNSATISFIABLE$/i.test(line)) {
        parsedLine = "unsat";
        break;
      }
    }

    let actual: "sat" | "unsat" | null = null;
    if (res.status !== 0 && res.status !== 10 && res.status !== 20) {
      actual = null;
    } else if (res.status === 10 && parsedLine !== "unsat") {
      actual = "sat";
    } else if (res.status === 20 && parsedLine !== "sat") {
      actual = "unsat";
    } else if (
      res.status === 0 &&
      (parsedLine === "sat" || parsedLine === "unsat")
    ) {
      actual = parsedLine;
    } else {
      actual = null;
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

    if (res.status !== 0) {
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
          `SMT solver exited with code ${res.status}`,
      };
    }

    const stdoutLines = (res.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let actual: "sat" | "unsat" | null = null;
    for (const line of stdoutLines) {
      const lower = line.toLowerCase();
      if (lower === "sat" || lower === "unsat") {
        actual = lower;
        break;
      }
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
          `Unexpected z3 output: ${stdoutLines[0] || "(empty)"}`,
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

    return {
      docPath,
      kind: "smt",
      status: "pass",
      command,
      exitCode: res.status,
      durationMs: Date.now() - startTime,
      message: `SMT check passed (actual: ${actual})`,
    };
  }

  if (spec.kind === "lean") {
    if (!spec.file && !spec.symbol) {
      return {
        docPath,
        kind: "lean",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: "Missing file or symbol in lean verify spec",
        alignment: "not_checked",
      };
    }

    if (spec.symbol && !/^[A-Za-z_][\w.']*$/.test(spec.symbol.trim())) {
      return {
        docPath,
        kind: "lean",
        status: "error",
        command: [],
        exitCode: null,
        durationMs: Date.now() - startTime,
        message: `Invalid Lean symbol name: ${spec.symbol}`,
        alignment: "not_checked",
      };
    }

    let fileAbs: string | null = null;
    if (spec.file) {
      fileAbs = resolveSafePath(workspaceRoot, spec.file);
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
    }

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

    const hasLake =
      (fs.existsSync(path.join(workspaceRoot, "lakefile.lean")) ||
        fs.existsSync(path.join(workspaceRoot, "lakefile.toml"))) &&
      hasBinary("lake");

    if (fileAbs && !spec.symbol) {
      const command = hasLake
        ? ["lake", "env", "lean", fileAbs]
        : ["lean", fileAbs];
      const res = hasLake
        ? spawnSync("lake", ["env", "lean", fileAbs], {
            cwd: workspaceRoot,
            encoding: "utf8",
            timeout,
          })
        : spawnSync("lean", [fileAbs], {
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
          : (res.stderr?.trim() ||
            res.stdout?.trim() ||
            `Lean exited with code ${res.status}`),
        alignment: "not_checked",
      };
    }

    if (spec.symbol) {
      const symbol = spec.symbol.trim();
      let tmpDir: string | null = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-verify-"));
        const { modules, files } = resolveWorkspaceLeanModules(
          workspaceRoot,
          symbol,
          spec.file,
        );
        const importLines = modules.map((m) => `import ${m}`).join("\n");
        const probeFile = path.join(tmpDir, "Probe.lean");
        const probeContent = importLines
          ? `${importLines}\n\n#check ${symbol}\n`
          : `#check ${symbol}\n`;
        fs.writeFileSync(probeFile, probeContent, "utf8");

        const env = { ...process.env, LEAN_SRC_PATH: workspaceRoot };
        let command = hasLake
          ? ["lake", "env", "lean", probeFile]
          : ["lean", probeFile];
        let res = hasLake
          ? spawnSync("lake", ["env", "lean", probeFile], {
              cwd: workspaceRoot,
              env,
              encoding: "utf8",
              timeout,
            })
          : spawnSync("lean", [probeFile], {
              cwd: workspaceRoot,
              env,
              encoding: "utf8",
              timeout,
            });

        if (res.status !== 0 && files.length > 0) {
          const inlineSources: string[] = [];
          for (const f of files) {
            try {
              inlineSources.push(fs.readFileSync(f, "utf8"));
            } catch (_err) {
              // ignore read failure
            }
          }
          if (inlineSources.length > 0) {
            const inlineFile = path.join(tmpDir, "ProbeInline.lean");
            fs.writeFileSync(
              inlineFile,
              `${inlineSources.join("\n\n")}\n\n#check ${symbol}\n`,
              "utf8",
            );
            command = ["lean", inlineFile];
            res = spawnSync("lean", [inlineFile], {
              cwd: workspaceRoot,
              env,
              encoding: "utf8",
              timeout,
            });
          }
        }

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
