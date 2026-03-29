import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MarkdownText } from "../../src/desktop/src/components/MarkdownText"

describe("desktop markdown text", () => {
  test("renders headings, lists, links, inline code, and fenced code blocks semantically", () => {
    const html = renderToStaticMarkup(
      <MarkdownText
        text={[
          "# Heading",
          "",
          "Use `grep` before [docs](https://example.com/docs).",
          "",
          "- First item",
          "- Second item",
          "",
          "```ts",
          "const value = 1",
          "```",
        ].join("\n")}
      />,
    )

    expect(html).toContain("<h1")
    expect(html).toContain(">Heading</h1>")
    expect(html).toContain("<code")
    expect(html).toContain(">grep</code>")
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain("<ul")
    expect(html).toContain("<li>First item</li>")
    expect(html).toContain("<pre")
    expect(html).toContain("const value = 1")
  })

  test("leaves unsupported links as plain text", () => {
    const html = renderToStaticMarkup(
      <MarkdownText text={"Look at [unsafe](javascript:alert(1)) before continuing."} />,
    )

    expect(html).not.toContain("href=")
    expect(html).toContain("[unsafe](javascript:alert(1))")
  })
})
