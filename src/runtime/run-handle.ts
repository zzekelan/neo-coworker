import type { RuntimeEvent } from "./events"
import type { PermissionResponse } from "../permission/service"

export type RunHandle = {
  events: AsyncIterable<RuntimeEvent>
  cancel(): void | Promise<void>
  respondPermission(input: PermissionResponse): void | Promise<void>
}
