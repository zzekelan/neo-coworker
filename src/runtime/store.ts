type Session = {
  id: string
  cwd: string
  workspaceRoot: string
}

type Run = {
  id: string
  sessionId: string
  trigger: "cli"
  status: "queued"
}

type MessagePart = {
  type: string
  text?: string
}

type Message = {
  sessionId: string
  runId: string
  role: string
  parts: MessagePart[]
}

export function createStore() {
  const sessions = new Map<string, Session>()
  const runs = new Map<string, Run>()
  const messages = new Map<string, Message[]>()

  return {
    createSession(input: Omit<Session, "id">) {
      const session = { id: `session_${sessions.size + 1}`, ...input }
      sessions.set(session.id, session)
      messages.set(session.id, [])
      return session
    },
    createRun(input: Omit<Run, "id" | "status">) {
      const run = { id: `run_${runs.size + 1}`, status: "queued" as const, ...input }
      runs.set(run.id, run)
      return run
    },
    appendMessage(message: Message) {
      messages.get(message.sessionId)?.push(message)
      return message
    },
    listMessages(sessionId: string) {
      return messages.get(sessionId) ?? []
    },
  }
}
