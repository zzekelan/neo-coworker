import { z } from "zod"
import { throwIfToolAborted, type ToolDefinition } from "../../domain"

const DatetimeArgsSchema = z.object({}).describe(
  "Return the current system datetime without mutating state or requesting permissions.",
)

function formatUtcOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")
  const minutes = String(absoluteMinutes % 60).padStart(2, "0")

  return `${sign}${hours}:${minutes}`
}

function formatLocalIso(date: Date) {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0")

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${formatUtcOffset(date)}`
}

export function createDatetimeTool(): ToolDefinition {
  return {
    name: "get_current_datetime",
    description:
      "Return the current system datetime as an ISO 8601 string with milliseconds, plus the detected timezone name and UTC offset. Use this when a caller needs the current local time context without any calendar math, timezone conversion, or permission prompt.",
    inputSchema: DatetimeArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    async execute(input) {
      throwIfToolAborted(input.signal)

      const args = DatetimeArgsSchema.parse(input.args)
      void args

      const now = new Date()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
      const utcOffset = formatUtcOffset(now)
      const iso = formatLocalIso(now)
      const epochMs = now.getTime()

      return {
        output: `Current datetime: ${iso}\nTimezone: ${timezone}\nUTC offset: ${utcOffset}\nEpoch ms: ${epochMs}`,
        metadata: {
          iso,
          timezone,
          utcOffset,
          epoch_ms: epochMs,
        },
      }
    },
  }
}
