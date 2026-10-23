export const THEOREM_STATUSES = ["draft", "proved", "refuted"] as const;
export type TheoremStatus = (typeof THEOREM_STATUSES)[number];

export const VERIFIER_KINDS = ["python", "sat", "smt", "lean"] as const;
export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export interface VerifySpec {
  kind: VerifierKind;
  script?: string;
  file?: string;
  expect?: "sat" | "unsat";
  symbol?: string;
  timeoutMs?: number;
}

export function normalizeTheoremStatus(raw: unknown): TheoremStatus {
  if (typeof raw !== "string") {
    return "proved";
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "draft" ||
    normalized === "conjecture" ||
    normalized === "raw" ||
    normalized === "locally_tested"
  ) {
    return "draft";
  }
  if (normalized === "refuted" || normalized === "obsolete") {
    return "refuted";
  }
  return "proved";
}

export function parseVerifySpecs(raw: unknown): VerifySpec[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const specs: VerifySpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const rawKind = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase() : "";
    if (
      rawKind !== "python" &&
      rawKind !== "sat" &&
      rawKind !== "smt" &&
      rawKind !== "lean"
    ) {
      continue;
    }
    const spec: VerifySpec = { kind: rawKind };

    if (typeof rec.script === "string" && rec.script.trim() !== "") {
      spec.script = rec.script.trim();
    }
    if (typeof rec.file === "string" && rec.file.trim() !== "") {
      spec.file = rec.file.trim();
    }
    if (typeof rec.symbol === "string" && rec.symbol.trim() !== "") {
      spec.symbol = rec.symbol.trim();
    }
    if (rec.expect === "sat" || rec.expect === "unsat") {
      spec.expect = rec.expect;
    }
    if (typeof rec.timeoutMs === "number" && !Number.isNaN(rec.timeoutMs) && rec.timeoutMs > 0) {
      spec.timeoutMs = rec.timeoutMs;
    }

    specs.push(spec);
  }
  return specs;
}
