import type {
  MessageRole,
  PartKind,
  RunStatus,
  RunTokenUsageSource,
  RunTrigger,
  StoredMessage,
  StoredPart,
  StoredRun,
  StoredSession,
} from "../application/ports/repository"

export type SessionRow = {
  id: string
  directory: string
  workspace_root: string
  created_at: number
  title: string
  updated_at: number
  latest_user_message_preview: string | null
  active_skills_json: string
}

export type RunRow = {
  id: string
  session_id: string
  trigger: RunTrigger
  status: RunStatus
  created_at: number
  session_sequence: number
  started_at: number | null
  finished_at: number | null
  error_text: string | null
  active_skills_json: string
  input_tokens: number
  output_tokens: number
  token_usage_source: RunTokenUsageSource | null
}

export type MessageRow = {
  id: string
  session_id: string
  run_id: string
  role: MessageRole
  sequence: number
  created_at: number
}

export type PartRow = {
  id: string
  session_id: string
  run_id: string
  message_id: string
  kind: PartKind
  sequence: number
  text_value: string | null
  data_json: string | null
  created_at: number
}

export type TranscriptRow = {
  message_id: string
  message_session_id: string
  message_run_id: string
  message_role: MessageRole
  message_sequence: number
  message_created_at: number
  part_id: string | null
  part_session_id: string | null
  part_run_id: string | null
  part_message_id: string | null
  part_kind: PartKind | null
  part_sequence: number | null
  part_text_value: string | null
  part_data_json: string | null
  part_created_at: number | null
}

export function mapSessionRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    directory: row.directory,
    workspaceRoot: row.workspace_root,
    createdAt: row.created_at,
    title: row.title,
    updatedAt: row.updated_at,
    latestUserMessagePreview: row.latest_user_message_preview,
    activeSkills: parseJson(row.active_skills_json) as string[],
  }
}

export function mapRunRow(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    trigger: row.trigger,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorText: row.error_text,
    activeSkills: parseJson(row.active_skills_json) as string[],
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    tokenUsageSource: row.token_usage_source,
  }
}

export function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    sequence: row.sequence,
    createdAt: row.created_at,
  }
}

export function mapPartRow(row: PartRow): StoredPart {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    messageId: row.message_id,
    kind: row.kind,
    sequence: row.sequence,
    text: row.text_value,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  }
}

export function serializeJson(value: unknown) {
  if (value === null || value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

function parseJson(value: string | null) {
  if (value === null) {
    return null
  }

  return JSON.parse(value)
}
