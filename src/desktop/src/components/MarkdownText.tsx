import React from "react"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "../lib/utils"

export function MarkdownText(input: {
  text: string
  className?: string
}) {
  return (
    <div className={cn("min-w-0", input.className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {input.text}
      </ReactMarkdown>
    </div>
  )
}

function isSafeHref(href: string) {
  return /^(https?:|mailto:)/.test(href)
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-3 text-3xl font-semibold tracking-tight text-zinc-950">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-3 text-2xl font-semibold tracking-tight text-zinc-950">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-2 text-xl font-semibold tracking-tight text-zinc-950">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-2 text-lg font-semibold tracking-tight text-zinc-950">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 mb-2 text-base font-semibold tracking-tight text-zinc-900">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-3 mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-zinc-600">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="my-3 leading-7 text-zinc-800">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-zinc-950">{children}</strong>,
  em: ({ children }) => <em className="italic text-zinc-900">{children}</em>,
  del: ({ children }) => <del className="text-zinc-500 line-through">{children}</del>,
  a: ({ href, children }) => {
    if (!href || !isSafeHref(href)) {
      return <span>{children}</span>
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-indigo-600 underline decoration-indigo-300 underline-offset-4 hover:text-indigo-500"
      >
        {children}
      </a>
    )
  },
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-3 space-y-1 pl-6 text-zinc-800",
        className?.includes("contains-task-list") ? "list-none pl-0" : "list-disc",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-zinc-800">{children}</ol>,
  li: ({ children, className }) => (
    <li className={cn(className?.includes("task-list-item") ? "flex items-start gap-3" : undefined)}>
      {children}
    </li>
  ),
  hr: () => <hr className="my-6 border-0 border-t border-zinc-200" />,
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <table className="min-w-full border-collapse text-left text-sm text-zinc-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-50/80 text-zinc-900">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-zinc-200">{children}</tbody>,
  tr: ({ children }) => <tr className="align-top">{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-zinc-200 px-4 py-3 text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-4 py-3 leading-6 text-zinc-800">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-2xl border border-zinc-200 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 shadow-sm selection:bg-sky-200 selection:text-zinc-950">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const isBlockCode = Boolean(className && className.startsWith("language-"))

    if (isBlockCode) {
      return (
        <code className={cn(className, "bg-transparent text-inherit selection:bg-sky-200 selection:text-zinc-950")}>
          {children}
        </code>
      )
    }

    return (
      <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[0.95em] text-zinc-900 selection:bg-zinc-200 selection:text-zinc-950">
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
          className="mt-1 h-4 w-4 shrink-0 rounded border-zinc-300 text-zinc-900 accent-zinc-900"
        />
      )
    }

    return <input type={type} disabled={disabled} readOnly />
  },
}
