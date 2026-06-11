"use client";

import { type ComponentProps } from "react";
import { Streamdown } from "streamdown";

import { installClipboardFallback } from "@/core/clipboard";
import { clampMarkdownBlockquoteNesting } from "@/core/streamdown/preprocess";

export type ClipboardSafeStreamdownProps = ComponentProps<typeof Streamdown>;

// Only patch browser globals in client context; skip during SSR
if (typeof document !== "undefined") {
  installClipboardFallback();
}

export function ClipboardSafeStreamdown({
  children,
  ...props
}: ClipboardSafeStreamdownProps) {
  const safeChildren =
    typeof children === "string"
      ? clampMarkdownBlockquoteNesting(children)
      : children;

  return <Streamdown {...props}>{safeChildren}</Streamdown>;
}
