import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MarkdownText } from "../../src/desktop/src/components/MarkdownText"

describe("desktop markdown text", () => {
  test("renders headings, gfm rich text, lists, links, and fenced code blocks semantically", () => {
    const html = renderToStaticMarkup(
      <MarkdownText
        text={[
          "# Heading",
          "",
          "Use `grep`, **bold**, *italics*, and ~~deletions~~ before [docs](https://example.com/docs).",
          "",
          "- First item",
          "- Second item",
          "",
          "---",
          "",
          "| Name | Age |",
          "| --- | --- |",
          "| Ada | 32 |",
          "",
          "- [x] Done",
          "- [ ] Pending",
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
    expect(html).toContain("<strong")
    expect(html).toContain(">bold</strong>")
    expect(html).toContain("<em")
    expect(html).toContain(">italics</em>")
    expect(html).toContain("<del")
    expect(html).toContain(">deletions</del>")
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain("<ul")
    expect(html).toContain(">First item</li>")
    expect(html).toContain("<hr")
    expect(html).toContain("<table")
    expect(html).toContain("<th")
    expect(html).toContain(">Ada</td>")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
    expect(html).toContain("<pre")
    expect(html).toContain('class="language-ts')
    expect(html).toContain("const value = 1")
  })

  test("renders unsafe links as non-clickable text", () => {
    const html = renderToStaticMarkup(
      <MarkdownText text={"Look at [unsafe](javascript:alert(1)) before continuing."} />,
    )

    expect(html).not.toContain("href=")
    expect(html).toContain("unsafe")
    expect(html).toContain("before continuing.")
  })

  test("omits markdown images instead of emitting img tags", () => {
    const html = renderToStaticMarkup(
      <MarkdownText text={"Preview ![diagram](https://example.com/a.png) before continuing."} />,
    )

    expect(html).not.toContain("<img")
    expect(html).not.toContain("https://example.com/a.png")
    expect(html).toContain("[Image omitted: diagram]")
  })
})
