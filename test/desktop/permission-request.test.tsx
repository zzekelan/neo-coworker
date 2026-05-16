import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop permission request", () => {
  test("focuses the first pending card and supports keyboard approval shortcuts", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("autoFocus?: boolean")
    expect(source).toContain("variant?: \"card\" | \"composer\"")
    expect(source).toContain("const [isSubmitting, setIsSubmitting] = useState(false)")
    expect(source).toContain("cardRef.current?.focus()")
    expect(source).toContain("tabIndex={0}")
    expect(source).toContain("if (isSubmitting)")
    expect(source).toContain("if (event.key === \"Enter\")")
    expect(source).toContain("const applied = await onReply(request.id, decision)")
    expect(source).toContain("if (applied === false)")
    expect(source).toContain("void submitReply(\"allow\")")
    expect(source).toContain("if (event.key === \"Escape\")")
    expect(source).toContain("void submitReply(\"deny\")")
    expect(source).toContain("disabled={isSubmitting}")
  })

  test("can occupy the composer while permission is pending", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("variant = \"card\"")
    expect(source).toContain("const isComposer = variant === \"composer\"")
    expect(source).toContain("min-h-[132px] rounded-2xl bg-paper px-4 py-3")
    expect(source).toContain("{text.permission.title}")
    expect(source).toContain("type=\"button\"")
  })

  test("hides the card once the underlying request is no longer pending so siblings stay visible", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("if (request.status !== \"pending\")")
    expect(source).toContain("return null")
  })

  test("warns on missing patch preview while preserving approval actions", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("const isPatchRequest = request.toolName === \"apply_patch\"")
    expect(source).toContain("const isPatchPreviewMissing = isPatchRequest && !request.preview")
    expect(source).toContain("{isPatchPreviewMissing ? (")
    expect(source).toContain("{text.permission.patchPreviewMissingTitle}")
    expect(source).toContain("{text.permission.patchPreviewMissingBody}")
    expect(source).toContain("request.approvalDetails?.kind === \"patch\"")
    expect(source).toContain("onClick={() => void submitReply(\"deny\")}")
    expect(source).toContain("onClick={() => void submitReply(\"allow\")}")
  })
})
