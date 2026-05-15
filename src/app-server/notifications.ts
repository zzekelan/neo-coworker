import type { AppServerNotification } from "../bootstrap"

export type { AppServerNotification } from "../bootstrap"

export function serializeSseNotification(notification: AppServerNotification) {
  return `id: ${notification.id}\nevent: ${notification.type}\ndata: ${JSON.stringify(notification)}\n\n`
}
