const FENCED_CODE_BLOCK_PATTERN = /(^|\n)\s*(```|~~~)/;

const SOURCE_DECLARATION_PATTERN =
  /^\s*(?:#\s*(?:include|define|if|ifdef|ifndef|endif)|import\s+[\w*{]|from\s+[\w.]+\s+import\b|package\s+[\w.]+|using\s+[\w.:]+|namespace\s+\w+|(?:export\s+)?(?:async\s+)?function\b|(?:export\s+)?(?:const|let|var|type|interface|enum|class)\b|(?:public|private|protected|static|final|abstract)\b|def\s+\w+\s*\(|class\s+\w+|func\s+\w+\s*\()/;

const C_LIKE_FUNCTION_PATTERN =
  /^\s*(?:(?:static|inline|extern|const|unsigned|signed)\s+)*(?:void|int|char|float|double|long|short|bool|pid_t|size_t|ssize_t|struct\s+\w+|enum\s+\w+|[A-Za-z_][\w:<>*&\s]+)\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(?:\{|;)?\s*$/;

const CONTROL_FLOW_PATTERN =
  /^\s*(?:if|else|for|while|switch|case|default|return|try|catch|finally|do)\b.*(?:[();{}]|:)$/;

const COMMENT_PATTERN =
  /^\s*(?:\/\/|\/\*|\*\/?|\* |#(?!\s*(?:#{1,5}\s|\d+\s|[-*]\s)))/;

const ASSIGNMENT_PATTERN =
  /^\s*[A-Za-z_$][\w.$]*(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)*\s*(?:=|:=|\+=|-=|\*=|\/=)\s*.+[;,]?\s*$/;

const LOG_OR_TRACE_PATTERN =
  /^\s*(?:at\s+[\w.$<>]+\s*\(|Traceback \(most recent call last\):|\w+(?:Error|Exception):|[-+]?\d{4}-\d{2}-\d{2}.*\b(?:ERROR|WARN|INFO|DEBUG)\b)/;

function isCodeLikeLine(line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  return (
    SOURCE_DECLARATION_PATTERN.test(line) ||
    C_LIKE_FUNCTION_PATTERN.test(line) ||
    CONTROL_FLOW_PATTERN.test(line) ||
    COMMENT_PATTERN.test(line) ||
    ASSIGNMENT_PATTERN.test(line) ||
    LOG_OR_TRACE_PATTERN.test(line) ||
    /[{};]/.test(trimmed) ||
    /(?:=>|->|::|&&|\|\||\+\+|--)/.test(trimmed) ||
    /^<\/?[A-Za-z][\w:-]*(?:\s+[^>]*)?>$/.test(trimmed)
  );
}

export function shouldRenderHumanMessageAsPlainText(content: string): boolean {
  const normalized = content.replace(/\r\n?/g, "\n").trimEnd();

  if (!normalized || FENCED_CODE_BLOCK_PATTERN.test(normalized)) {
    return false;
  }

  const lines = normalized.split("\n");
  const nonBlankLines = lines.filter((line) => line.trim().length > 0);

  if (nonBlankLines.length < 6) {
    return false;
  }

  const codeLikeCount = nonBlankLines.filter(isCodeLikeLine).length;
  const declarationCount = nonBlankLines.filter(
    (line) =>
      SOURCE_DECLARATION_PATTERN.test(line) ||
      C_LIKE_FUNCTION_PATTERN.test(line),
  ).length;
  const indentedCount = nonBlankLines.filter((line) =>
    /^(?: {4,}|\t)/.test(line),
  ).length;
  const structuralCount = nonBlankLines.filter((line) =>
    /[{};]/.test(line),
  ).length;
  const traceCount = nonBlankLines.filter((line) =>
    LOG_OR_TRACE_PATTERN.test(line),
  ).length;
  const codeLikeRatio = codeLikeCount / nonBlankLines.length;

  if (traceCount >= 3 && codeLikeRatio >= 0.35) {
    return true;
  }

  if (declarationCount >= 2 && structuralCount >= 2 && codeLikeCount >= 4) {
    return true;
  }

  if (nonBlankLines.length >= 8 && indentedCount >= 3 && codeLikeRatio >= 0.4) {
    return true;
  }

  return (
    nonBlankLines.length >= 10 &&
    codeLikeRatio >= 0.45 &&
    structuralCount + indentedCount >= 4
  );
}
