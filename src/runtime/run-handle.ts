import type { RuntimeEvent } from "./events"
import type { PermissionResponse } from "./permissions"

export type RunHandle = {
  events: AsyncIterable<RuntimeEvent>
  cancel(): void | Promise<void>
  respondPermission(input: PermissionResponse): void | Promise<void>
}
