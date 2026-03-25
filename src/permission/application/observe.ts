import type {
  PermissionObserverEvent,
  PermissionObserverPort,
} from "./ports/permission-observer"

export function observePermissionEvent(
  observer: PermissionObserverPort | undefined,
  event: PermissionObserverEvent,
) {
  try {
    observer?.recordPermissionEvent?.(event)
  } catch {
    // Observability must not alter permission flow behavior.
  }
}
