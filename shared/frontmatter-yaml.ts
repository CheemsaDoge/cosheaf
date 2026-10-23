import { parse, stringify } from "yaml";
import type { TheoremStatus, VerifySpec } from "./theorem-status.js";

export type { TheoremStatus, VerifySpec };

export interface Frontmatter {
  id?: string;
  title?: string;
  type?: string;
  target?: string;
  status?: TheoremStatus | string | null;
  verify?: VerifySpec[];
  tags?: string[];
  [key: string]: unknown;
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
  hadFrontmatter: boolean;
}

export interface MarkdownHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  from: number;
}

export function parseFrontmatterYaml(content: string): ParsedDocument {
  const openingFenceLength = frontmatterOpeningFenceLength(content);
  if (openingFenceLength === null) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  const closingFence = findClosingFrontmatterFence(content, openingFenceLength);
  if (!closingFence) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  try {
    const raw = parse(content.slice(openingFenceLength, closingFence.yamlEnd));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { frontmatter: {}, body: content.slice(closingFence.bodyStart), hadFrontmatter: true };
    }
    return {
      frontmatter: raw as Frontmatter,
      body: content.slice(closingFence.bodyStart),
      hadFrontmatter: true,
    };
  } catch (_err) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
}

// Drop undefined/null/empty-string frontmatter values (the shared "what counts
// as empty" rule for serialization, used by both this YAML serializer and the
// Coflat document serializer).
export function compactFrontmatter(frontmatter: Frontmatter): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== null && value !== "") compacted[key] = value;
  }
  return compacted;
}

export function serializeFrontmatterYaml(frontmatter: Frontmatter, body: string): string {
  const compacted = compactFrontmatter(frontmatter);
  const cleanBody = trimLeadingLineFeeds(body);
  if (Object.keys(compacted).length === 0) return cleanBody;
  return `---\n${stringify(compacted).trimEnd()}\n---\n${cleanBody}`;
}

export function extractFirstH1(body: string): string | null {
  return extractAtxHeadings(body).find((heading) => heading.level === 1)?.text ?? null;
}

export function extractAtxHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence: "`" | "~" | null = null;
  for (const line of sourceLines(source)) {
    const fence = fenceMarker(line.text);
    if (fence) {
      if (!inFence) {
        inFence = fence;
      } else if (inFence === fence) {
        inFence = null;
      }
      continue;
    }
    if (inFence) continue;
    const heading = atxHeading(line.text);
    if (heading) {
      headings.push({
        ...heading,
        line: line.number,
        from: line.from,
      });
    }
  }
  return headings;
}

export function trimLeadingLineFeeds(body: string): string {
  let pos = 0;
  while (body[pos] === "\n") pos++;
  return pos === 0 ? body : body.slice(pos);
}

function frontmatterOpeningFenceLength(content: string): number | null {
  if (content === "---") return 3;
  if (content.startsWith("---\n")) return 4;
  if (content.startsWith("---\r\n")) return 5;
  return null;
}

function findClosingFrontmatterFence(
  content: string,
  bodyStart: number,
): { yamlEnd: number; bodyStart: number } | null {
  for (const line of sourceLines(content, bodyStart)) {
    if (line.text !== "---") continue;
    return {
      yamlEnd: line.from > bodyStart && content.charCodeAt(line.from - 1) === 13 ? line.from - 1 : line.from,
      bodyStart: line.nextFrom,
    };
  }
  return null;
}

function sourceLines(source: string, start = 0): Array<{ text: string; from: number; nextFrom: number; number: number }> {
  const lines: Array<{ text: string; from: number; nextFrom: number; number: number }> = [];
  let lineStart = start;
  let number = 1;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? source.length : lineEnd;
    let text = source.slice(lineStart, end);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    lines.push({ text, from: lineStart, nextFrom: lineEnd < 0 ? source.length : lineEnd + 1, number });
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
    number++;
  }
  return lines;
}

function fenceMarker(line: string): "`" | "~" | null {
  const trimmed = line.trimStart();
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") return null;
  let count = 0;
  while (trimmed[count] === marker) count++;
  return count >= 3 ? marker : null;
}

function atxHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  let pos = 0;
  while (line[pos] === " " || line[pos] === "\t") pos++;
  let level = 0;
  while (line[pos + level] === "#") level++;
  if (level < 1 || level > 6) return null;
  const afterMarker = line[pos + level];
  if (afterMarker !== " " && afterMarker !== "\t") return null;
  let text = line.slice(pos + level + 1).trim();
  while (text.endsWith("#")) {
    const hashStart = text.lastIndexOf("#");
    if (hashStart <= 0 || (text[hashStart - 1] !== " " && text[hashStart - 1] !== "\t")) break;
    text = text.slice(0, hashStart).trimEnd();
  }
  return text ? { level: level as 1 | 2 | 3 | 4 | 5 | 6, text } : null;
}
