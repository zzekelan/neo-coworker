import type { RuntimeEvent } from "../runtime/events"

export function renderEvent(event: RuntimeEvent) {
  switch (event.type) {
    case "run.started":
      return `run.started ${event.runId}\n`
    case "message.started":
      return `message.started ${event.role}\n`
    case "message.delta":
      return event.text
    case "permission.requested":
      return `permission.requested ${event.toolName} ${event.reason}\n`
    case "tool.call.completed":
      return `tool.call.completed ${event.name}: ${event.output}\n`
    case "run.completed":
      return `run.completed ${event.runId}\n`
    case "run.failed":
      return `run.failed ${event.error}\n`
    case "run.cancelled":
      return `run.cancelled ${event.runId}\n`
  }
}
