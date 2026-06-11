import { describe, expect, it } from "vitest";

import {
  clampMarkdownBlockquoteNesting,
  preprocessStreamdownMarkdown,
} from "@/core/streamdown/preprocess";

function leadingBlockquoteDepth(line: string): number {
  let index = 0;
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

  return count;
}

describe("streamdown markdown preprocessing", () => {
  it("clamps deeply nested blockquote markers before markdown reaches Streamdown", () => {
    const markdown = `${Array.from({ length: 150 }, () => ">").join(" ")} quoted text`;
    const clamped = clampMarkdownBlockquoteNesting(markdown);

    expect(leadingBlockquoteDepth(clamped)).toBe(100);
    expect(clamped).toContain("\\>");
    expect(clamped).toContain("quoted text");
  });

  it("does not rewrite blockquote-like content inside fenced code blocks", () => {
    const nestedQuote = `${Array.from({ length: 150 }, () => ">").join(" ")} quoted text`;
    const markdown = `\`\`\`text\n${nestedQuote}\n\`\`\``;

    expect(clampMarkdownBlockquoteNesting(markdown)).toBe(markdown);
  });

  it("keeps ordinary blockquotes unchanged", () => {
    const markdown = `> previous\n> > nested\n> > > reply`;

    expect(clampMarkdownBlockquoteNesting(markdown)).toBe(markdown);
  });

  it("runs blockquote clamping before mermaid normalization", () => {
    const nestedQuote = `${Array.from({ length: 150 }, () => ">").join(" ")} quoted text`;
    const markdown = `${nestedQuote}\n\n\`\`\`mermaid\ngraph TD\nA -- \"label\" -.-> B\n\`\`\``;
    const preprocessed = preprocessStreamdownMarkdown(markdown);

    expect(leadingBlockquoteDepth(preprocessed.split("\n")[0] ?? "")).toBe(100);
    expect(preprocessed).toContain('A -. "label" .-> B');
  });
});
