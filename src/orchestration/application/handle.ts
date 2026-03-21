import type { RuntimeEvent } from "./event"
import type { OrchestrationRunPermissionResponse } from "./permission"

export type OrchestrationRunHandle = {
  events: AsyncIterable<RuntimeEvent>
  cancel(): void | Promise<void>
  respondPermission(input: OrchestrationRunPermissionResponse): void | Promise<void>
}

export type RunHandle = OrchestrationRunHandle
