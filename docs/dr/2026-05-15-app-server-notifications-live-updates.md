---
status: accepted
---

# App Server Notifications are best-effort live updates

Neo Coworker treats **App Server Notifications** as the App Server boundary contract for live UI updates, not as durable facts, replay logs, or event-sourcing records. Authoritative recovery comes from read APIs and storage-backed state such as the **Session Timeline**, **Run** lifecycle state, **Permission Request** state, and current **Context Usage Snapshots**; the notification stream may carry convenience payloads, but clients must be able to replace notification-derived state with authoritative snapshots.

## Considered Options

- **Durable/replayable notification stream**: would support sync-style recovery, but would duplicate responsibilities already owned by the **Session Timeline**, **Run** state, **Permission Request** state, and **Run Telemetry Records**.
- **Best-effort live update stream**: matches the current HTTP/SSE architecture, keeps reconnect recovery snapshot-based, and prevents App Clients from treating transient push messages as the source of truth.
- **Server-to-client request/response protocol for approvals**: would model approval prompts precisely, but is a larger protocol change with routing, timeout, and multi-client implications; current approval flow remains persisted **Permission Request** state plus reply API.

## Consequences

- Migrate app-server naming from generic event language to **App Server Notification** language, including the subscription endpoint and internal bus/type names.
- Timeline-content notifications use **Timeline Entry** and **Timeline Part** terminology, such as `timeline.entry.created` and `timeline.part.updated`, rather than legacy `message.*` names.
- Do not preserve legacy `ServerEvent`, `message.*`, or generic `/events` API names as canonical compatibility surfaces in the migration.
- A **Run** failure remains durable **Run** lifecycle state; immediate UI alerts may be derived from live notifications, but failure replay comes from read snapshots.
- **Permission Requests** remain authoritative approval state; `permission.requested` and `permission.updated` are live notifications, and decisions are submitted through the reply API.
- **Context Usage Snapshots** may be displayed through read snapshots and notifications, while historical/debug usage belongs in **Run Telemetry Records** or explicit **Run** usage fields.
- The SSE protocol field named `event` is a transport detail, not a domain term.
