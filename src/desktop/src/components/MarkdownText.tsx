import React from "react"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "../lib/utils"

function parseMarkdown(text: string) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
}

function MarkdownTextComponent(input: {
  text: string
  className?: string
}) {
  const isTest = typeof process !== "undefined" && process.env.NODE_ENV === "test"
  const content = isTest
    ? parseMarkdown(input.text)
    : React.useMemo(() => parseMarkdown(input.text), [input.text])

  return (
    <div className={cn("min-w-0", input.className)}>
      {content}
    </div>
  )
}

export const MarkdownText = React.memo(MarkdownTextComponent)

function isSafeHref(href: string) {
  return /^(https?:|mailto:)/.test(href)
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-3 text-3xl font-semibold tracking-tight text-ink">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-3 text-2xl font-semibold tracking-tight text-ink">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-2 text-xl font-semibold tracking-tight text-ink">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-2 text-lg font-semibold tracking-tight text-ink">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 mb-2 text-base font-semibold tracking-tight text-ink">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-3 mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-muted">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="my-3 leading-7 text-ink">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic text-ink">{children}</em>,
  del: ({ children }) => <del className="text-muted line-through">{children}</del>,
  a: ({ href, children }) => {
    if (!href || !isSafeHref(href)) {
      return <span>{children}</span>
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-highlight underline decoration-indigo-300 underline-offset-4 hover:text-highlight"
      >
        {children}
      </a>
    )
  },
  img: ({ alt }) => (
    <span className="text-sm text-muted">{alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}</span>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-3 space-y-1 pl-6 text-ink",
        className?.includes("contains-task-list") ? "list-none pl-0" : "list-disc",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-ink">{children}</ol>,
  li: ({ children, className }) => (
    <li className={cn(className?.includes("task-list-item") ? "flex items-start gap-3" : undefined)}>
      {children}
    </li>
  ),
  hr: () => <hr className="my-6 border-0 border-t border-border" />,
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto rounded-2xl border border-border bg-paper shadow-sm">
      <table className="min-w-full border-collapse text-left text-sm text-ink">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-paper text-ink">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-zinc-200">{children}</tbody>,
  tr: ({ children }) => <tr className="align-top">{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-border px-4 py-3 text-xs font-semibold tracking-[0.08em] text-muted uppercase">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-4 py-3 leading-6 text-ink">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink shadow-sm selection:bg-highlight/30 selection:text-ink">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const isBlockCode = Boolean(className && className.startsWith("language-"))

    if (isBlockCode) {
      return (
        <code className={cn(className, "bg-transparent text-inherit selection:bg-highlight/30 selection:text-ink")}>
          {children}
        </code>
      )
    }

    return (
      <code className="rounded-md bg-surface px-1.5 py-0.5 text-[0.95em] text-ink selection:bg-border selection:text-ink">
        {children}
      </code>
    )
  },
  input: ({ type, checked, disabled }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={Boolean(checked)}
          disabled={disabled}
          readOnly
          aria-label={Boolean(checked) ? "Completed task" : "Incomplete task"}
          className="mt-1 h-4 w-4 shrink-0 rounded border-border text-ink accent-zinc-900"
        />
      )
    }

    return <input type={type} disabled={disabled} readOnly />
  },
}
