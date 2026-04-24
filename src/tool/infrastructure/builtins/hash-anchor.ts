import { createHash } from "node:crypto"

const FIRST_LINE_BOM = "\uFEFF"
const ANCHOR_PATTERN = /^L([1-9]\d*)#([0-9a-f]{8})(?:\|(.*))?$/

export type EolStyle = "lf" | "crlf" | "none"

export type SplitLineMetadata = {
  lineNumber: number
  rawContent: string
  displayContent: string
  hasBom: boolean
  lineEnding: "\n" | "\r\n" | ""
}

export type ParsedAnchor = {
  lineNumber: number
  hash: string
  lineContent: string
}

export type InclusiveRange = {
  startLineNumber: number
  endLineNumber: number
  startLineIndex: number
  endLineIndex: number
  lineCount: number
}

export class HashAnchorError extends Error {
  constructor(
    readonly code:
      | "malformed_anchor"
      | "anchor_out_of_range"
      | "anchor_hash_mismatch"
      | "anchor_content_mismatch"
      | "anchor_range_reversed",
    message: string,
  ) {
    super(message)
    this.name = "HashAnchorError"
  }
}

export function hashDisplayedLineContent(content: string): string {
  return createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 8)
}

export function formatAnchorLine(lineNumber: number, lineContent: string): string {
  return `L${lineNumber}#${hashDisplayedLineContent(lineContent)}|${lineContent}`
}

export function parseAnchor(anchor: string): ParsedAnchor {
  const match = ANCHOR_PATTERN.exec(anchor)
  if (!match) {
    throw new HashAnchorError(
      "malformed_anchor",
      `Invalid anchor format: ${anchor}. Expected L{lineNumber}#{hash8}|{lineContent}`,
    )
  }

  return {
    lineNumber: Number(match[1]),
    hash: match[2],
    lineContent: match[3] ?? "",
  }
}

export function detectEolStyle(text: string): EolStyle {
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === "\r") {
      return text[index + 1] === "\n" ? "crlf" : "lf"
    }
    if (character === "\n") {
      return "lf"
    }
  }
  return "none"
}

export function splitLinesWithMetadata(text: string): SplitLineMetadata[] {
  const lines: SplitLineMetadata[] = []
  let start = 0
  let lineNumber = 1

  while (start < text.length) {
    let end = start
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
      end += 1
    }

    let lineEnding: "\n" | "\r\n" | "" = ""
    if (end < text.length) {
      if (text[end] === "\r" && text[end + 1] === "\n") {
        lineEnding = "\r\n"
        end += 2
      } else {
        lineEnding = "\n"
        end += 1
      }
    }

    const rawContent = text.slice(start, end - lineEnding.length)
    const hasBom = lineNumber === 1 && rawContent.startsWith(FIRST_LINE_BOM)
    lines.push({
      lineNumber,
      rawContent,
      displayContent: hasBom ? rawContent.slice(FIRST_LINE_BOM.length) : rawContent,
      hasBom,
      lineEnding,
    })

    lineNumber += 1
    start = end
  }

  if (text.length === 0) {
    return []
  }

  return lines
}

export function validateInclusiveRange(
  lines: SplitLineMetadata[],
  start: ParsedAnchor,
  end: ParsedAnchor = start,
): InclusiveRange {
  validateAnchorAgainstLine(lines, start)
  validateAnchorAgainstLine(lines, end)

  if (start.lineNumber > end.lineNumber) {
    throw new HashAnchorError(
      "anchor_range_reversed",
      `Anchor range is reversed: ${start.lineNumber} > ${end.lineNumber}`,
    )
  }

  return {
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startLineIndex: start.lineNumber - 1,
    endLineIndex: end.lineNumber - 1,
    lineCount: end.lineNumber - start.lineNumber + 1,
  }

  function validateAnchorAgainstLine(entries: SplitLineMetadata[], anchor: ParsedAnchor) {
    const line = entries[anchor.lineNumber - 1]
    if (!line) {
      throw new HashAnchorError(
        "anchor_out_of_range",
        `Anchor line ${anchor.lineNumber} is outside the available line range`,
      )
    }
    if (hashDisplayedLineContent(line.displayContent) !== anchor.hash) {
      throw new HashAnchorError(
        "anchor_hash_mismatch",
        `Anchor hash mismatch at line ${anchor.lineNumber}`,
      )
    }
    // Display suffix after `|` is advisory only; identity = line number + hash.
    // Hash mismatch above already proves stale content, so suffix differences
    // (e.g. stray quote from the model) must not trigger validation failure.
    return line
  }
}
