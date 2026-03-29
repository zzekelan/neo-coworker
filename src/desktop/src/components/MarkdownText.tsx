import React, { Fragment } from "react"

type MarkdownBlock =
  | {
      type: "heading"
      level: 1 | 2 | 3 | 4 | 5 | 6
      text: string
    }
  | {
      type: "paragraph"
      lines: string[]
    }
  | {
      type: "list"
      ordered: boolean
      items: string[]
    }
  | {
      type: "code"
      language: string | null
      content: string
    }

export function MarkdownText(input: {
  text: string
  className?: string
}) {
  const blocks = parseMarkdownBlocks(input.text)

  return (
    <div className={input.className}>
      {blocks.map((block, index) => (
        <React.Fragment key={index}>
          {renderBlock(block)}
        </React.Fragment>
      ))}
    </div>
  )
}

function renderBlock(block: MarkdownBlock) {
  if (block.type === "heading") {
    const HeadingTag = `h${block.level}` as const

    return (
      <HeadingTag className={headingClassNames[block.level]}>
        {renderInlineMarkdown(block.text)}
      </HeadingTag>
    )
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul"

    return (
      <ListTag className={block.ordered ? orderedListClassName : unorderedListClassName}>
        {block.items.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </ListTag>
    )
  }

  if (block.type === "code") {
    return (
      <pre className="my-4 overflow-x-auto rounded-2xl border border-zinc-200 bg-zinc-950 px-4 py-3 text-sm text-zinc-100">
        <code className={block.language ? `language-${block.language}` : undefined}>
          {block.content}
        </code>
      </pre>
    )
  }

  return (
    <p className="my-3 leading-7 text-zinc-800">
      {block.lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {renderInlineMarkdown(line)}
        </Fragment>
      ))}
    </p>
  )
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let key = 0

  while (cursor < text.length) {
    const codeIndex = text.indexOf("`", cursor)
    const linkIndex = text.indexOf("[", cursor)
    const nextIndex = findNextTokenIndex(codeIndex, linkIndex)

    if (nextIndex === -1) {
      pushTextNode(nodes, text.slice(cursor), key)
      break
    }

    if (nextIndex > cursor) {
      pushTextNode(nodes, text.slice(cursor, nextIndex), key)
      key += 1
    }

    if (nextIndex === codeIndex) {
      const closingIndex = text.indexOf("`", codeIndex + 1)

      if (closingIndex === -1) {
        pushTextNode(nodes, text.slice(codeIndex), key)
        break
      }

      nodes.push(
        <code
          key={`code-${key}`}
          className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[0.95em] text-zinc-900"
        >
          {text.slice(codeIndex + 1, closingIndex)}
        </code>,
      )
      key += 1
      cursor = closingIndex + 1
      continue
    }

    const parsedLink = parseMarkdownLink(text, linkIndex)
    if (!parsedLink) {
      pushTextNode(nodes, text.slice(linkIndex, linkIndex + 1), key)
      key += 1
      cursor = linkIndex + 1
      continue
    }

    nodes.push(
      <a
        key={`link-${key}`}
        href={parsedLink.href}
        target="_blank"
        rel="noreferrer"
        className="text-indigo-600 underline decoration-indigo-300 underline-offset-4 hover:text-indigo-500"
      >
        {parsedLink.label}
      </a>,
    )
    key += 1
    cursor = parsedLink.end
  }

  return nodes
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""

    if (!line.trim()) {
      index += 1
      continue
    }

    const codeFence = line.match(/^```([\w-]+)?\s*$/)
    if (codeFence) {
      const content: string[] = []
      index += 1

      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "")
        index += 1
      }

      if (index < lines.length && /^```\s*$/.test(lines[index] ?? "")) {
        index += 1
      }

      blocks.push({
        type: "code",
        language: codeFence[1] ?? null,
        content: content.join("\n"),
      })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as MarkdownBlock["level"],
        text: heading[2] ?? "",
      })
      index += 1
      continue
    }

    const unorderedItem = line.match(/^[-*]\s+(.*)$/)
    const orderedItem = line.match(/^\d+\.\s+(.*)$/)
    if (unorderedItem || orderedItem) {
      const ordered = Boolean(orderedItem)
      const items: string[] = []

      while (index < lines.length) {
        const listLine = lines[index] ?? ""
        const match = ordered
          ? listLine.match(/^\d+\.\s+(.*)$/)
          : listLine.match(/^[-*]\s+(.*)$/)

        if (!match) {
          break
        }

        items.push(match[1] ?? "")
        index += 1
      }

      blocks.push({
        type: "list",
        ordered,
        items,
      })
      continue
    }

    const paragraphLines: string[] = []

    while (index < lines.length) {
      const paragraphLine = lines[index] ?? ""

      if (!paragraphLine.trim()) {
        break
      }

      if (
        /^```/.test(paragraphLine) ||
        /^(#{1,6})\s+/.test(paragraphLine) ||
        /^[-*]\s+/.test(paragraphLine) ||
        /^\d+\.\s+/.test(paragraphLine)
      ) {
        break
      }

      paragraphLines.push(paragraphLine)
      index += 1
    }

    blocks.push({
      type: "paragraph",
      lines: paragraphLines,
    })
  }

  return blocks
}

function parseMarkdownLink(text: string, start: number) {
  const slice = text.slice(start)
  const match = slice.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)

  if (!match) {
    return null
  }

  const href = match[2] ?? ""
  if (!isSafeHref(href)) {
    return null
  }

  return {
    label: match[1] ?? href,
    href,
    end: start + match[0].length,
  }
}

function isSafeHref(href: string) {
  return /^(https?:|mailto:)/.test(href)
}

function findNextTokenIndex(...indexes: number[]) {
  return indexes
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1
}

function pushTextNode(nodes: React.ReactNode[], value: string, key: number) {
  if (!value) {
    return
  }

  nodes.push(<Fragment key={`text-${key}`}>{value}</Fragment>)
}

const headingClassNames: Record<MarkdownBlock["level"], string> = {
  1: "mt-4 mb-3 text-3xl font-semibold tracking-tight text-zinc-950",
  2: "mt-4 mb-3 text-2xl font-semibold tracking-tight text-zinc-950",
  3: "mt-4 mb-2 text-xl font-semibold tracking-tight text-zinc-950",
  4: "mt-4 mb-2 text-lg font-semibold tracking-tight text-zinc-950",
  5: "mt-3 mb-2 text-base font-semibold tracking-tight text-zinc-900",
  6: "mt-3 mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-zinc-600",
}

const unorderedListClassName = "my-3 list-disc space-y-1 pl-6 text-zinc-800"
const orderedListClassName = "my-3 list-decimal space-y-1 pl-6 text-zinc-800"
