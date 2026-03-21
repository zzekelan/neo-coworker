import type { ServerEvent } from "../bootstrap"

export type { ServerEvent } from "../bootstrap"

export function serializeSseEvent(event: ServerEvent) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
