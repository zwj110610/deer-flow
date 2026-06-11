import { normalizeMermaidMarkdown } from "./mermaid";

const MERMAID_BLOCK_HINT_RE = /mermaid/i;
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,}).*$/;
const MAX_BLOCKQUOTE_NESTING_DEPTH = 100;

function countLeadingBlockquoteMarkers(line: string):
  | {
      count: number;
      endIndex: number;
      leadingWhitespace: string;
    }
  | undefined {
  const leadingWhitespaceMatch = /^[ \t]*/.exec(line);
  const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? "";
  let index = leadingWhitespace.length;
  let count = 0;

  while (index < line.length) {
    while (line[index] === " " || line[index] === "\t") {
      index += 1;
    }

    if (line[index] !== ">") {
      break;
    }

    count += 1;
    index += 1;
  }

  if (count === 0) {
    return undefined;
  }

  return { count, endIndex: index, leadingWhitespace };
}

function isFenceLine(
  line: string,
  activeFenceChar?: string,
): string | undefined {
  const match = FENCE_LINE_RE.exec(line);
  const fence = match?.[1];

  if (!fence) {
    return undefined;
  }

  const fenceChar = fence.charAt(0);

  if (activeFenceChar && fenceChar !== activeFenceChar) {
    return undefined;
  }

  return fenceChar;
}

function clampBlockquoteLine(line: string): string {
  const markers = countLeadingBlockquoteMarkers(line);

  if (!markers || markers.count <= MAX_BLOCKQUOTE_NESTING_DEPTH) {
    return line;
  }

  const safeMarkers = Array.from(
    { length: MAX_BLOCKQUOTE_NESTING_DEPTH },
    () => ">",
  ).join(" ");
  const escapedOverflowMarkers = Array.from(
    { length: markers.count - MAX_BLOCKQUOTE_NESTING_DEPTH },
    () => "\\>",
  ).join(" ");
  const rest = line.slice(markers.endIndex).trimStart();
  const content = [escapedOverflowMarkers, rest].filter(Boolean).join(" ");

  return `${markers.leadingWhitespace}${safeMarkers}${content ? ` ${content}` : ""}`;
}

export function clampMarkdownBlockquoteNesting(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let activeFenceChar: string | undefined;

  const clampedLines = lines.map((line) => {
    const fenceChar = isFenceLine(line, activeFenceChar);

    if (fenceChar) {
      activeFenceChar = activeFenceChar ? undefined : fenceChar;
      return line;
    }

    if (activeFenceChar) {
      return line;
    }

    return clampBlockquoteLine(line);
  });

  return clampedLines.join("\n");
}

export function preprocessStreamdownMarkdown(markdown: string): string {
  const safeMarkdown = clampMarkdownBlockquoteNesting(markdown);

  if (
    !MERMAID_BLOCK_HINT_RE.test(safeMarkdown) ||
    !safeMarkdown.includes("-.->")
  ) {
    return safeMarkdown;
  }

  return normalizeMermaidMarkdown(safeMarkdown);
}
