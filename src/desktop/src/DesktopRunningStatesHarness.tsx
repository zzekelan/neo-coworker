import { useMemo, useState } from "react"
import { ChatArea } from "./components/ChatArea"
import { DesktopTextProvider } from "./i18n"
import { KeyboardShortcutProvider } from "./providers/KeyboardShortcutProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import type {
  DesktopContextUsage,
  DesktopPermissionRequest,
  DesktopPrimaryAgent,
  DesktopRun,
  DesktopSession,
  DesktopSessionSnapshot,
  DesktopSkillCatalogEntry,
  DesktopTranscriptMessage,
  MessagePart,
} from "./view-types"

type RunningFixtureKind =
  | "thinking"
  | "reasoning"
  | "tool"
  | "permission"
  | "queued"

const FIXTURE_KINDS: Array<{
  kind: RunningFixtureKind
  label: string
  description: string
}> = [
  {
    kind: "thinking",
    label: "Thinking",
    description: "Fallback thinking indicator while the run is active.",
  },
  {
    kind: "reasoning",
    label: "Reasoning stream",
    description: "Live reasoning block expanded during an active run.",
  },
  {
    kind: "tool",
    label: "Running tool",
    description: "Active tool call keeps the composer locked without fallback thinking.",
  },
  {
    kind: "permission",
    label: "Waiting permission",
    description: "Permission composer while the run is suspended.",
  },
  {
    kind: "queued",
    label: "Queued",
    description: "Queued run keeps the composer busy before streaming begins.",
  },
]

const SESSION_ID = "fixture-session-running-states"
const RUN_ID = "fixture-run-running-states"
const NOW = new Date("2026-04-28T10:00:00.000Z").toISOString()

const PRIMARY_AGENTS: DesktopPrimaryAgent[] = [
  {
    name: "general",
    displayName: "General",
    description: "Default desktop fixture agent",
  },
  {
    name: "reviewer",
    displayName: "Reviewer",
    description: "Review-oriented fixture agent",
  },
]

const SKILLS: DesktopSkillCatalogEntry[] = [
  {
    name: "browser",
    description: "Inspect and verify local browser UI",
    path: "/fixtures/skills/browser",
  },
  {
    name: "frontend",
    description: "Frontend layout and interaction checks",
    path: "/fixtures/skills/frontend",
  },
]

const CONTEXT_USAGE: DesktopContextUsage = {
  contextTokens: 12400,
  contextWindow: 200000,
  utilizationPercent: 6,
  source: "estimated",
}

export function DesktopRunningStatesHarness() {
  const [kind, setKind] = useState<RunningFixtureKind>("thinking")
  const fixture = useMemo(() => createRunningFixture(kind), [kind])

  return (
    <ThemeProvider theme="light" onThemeChange={() => {}}>
      <KeyboardShortcutProvider
        onNewSession={() => {}}
        onClearTranscript={() => {}}
        onCycleAgent={() => {}}
      >
        <DesktopTextProvider language="zh">
          <div className="flex h-screen w-full overflow-hidden bg-paper font-sans text-ink selection:bg-accent/20 selection:text-ink">
            <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-paper px-4 py-5">
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Desktop fixture
                </p>
                <h1 className="mt-1 text-lg font-semibold text-ink">
                  Running states
                </h1>
              </div>

              <div className="space-y-1.5">
                {FIXTURE_KINDS.map((scenario) => (
                  <button
                    key={scenario.kind}
                    type="button"
                    onClick={() => setKind(scenario.kind)}
                    className={[
                      "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                      scenario.kind === kind
                        ? "bg-surface text-ink shadow-sm"
                        : "text-accent hover:bg-surface hover:text-ink",
                    ].join(" ")}
                  >
                    <span className="block text-sm font-semibold">{scenario.label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted">
                      {scenario.description}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-auto rounded-lg border border-border bg-surface px-3 py-2.5 text-xs leading-5 text-muted">
                Open with <span className="font-mono text-ink">?fixture=running-states</span>.
                This path is dev-only and does not call the app-server.
              </div>
            </aside>

            <div className="relative flex min-w-0 flex-1 flex-col bg-paper">
              <ChatArea
                sessionSummary={fixture.sessionSummary}
                hasSessions
                session={fixture.session}
                skills={SKILLS}
                transcript={fixture.transcript}
                permissionRequests={fixture.permissionRequests}
                contextUsage={CONTEXT_USAGE}
                onSendMessage={() => undefined}
                onCancelRun={() => undefined}
                onReplyPermission={() => false}
                onSetSessionActiveSkills={() => undefined}
                onCreateSession={() => undefined}
                isSidebarOpen
                onToggleSidebar={() => undefined}
                errorMessage={null}
                skillWarningMessage={null}
                compatibilityPrompt={null}
                onStartNewSessionFromCompatibility={() => undefined}
                onContinueWithoutThinking={() => undefined}
                modelName="fixture-model"
                currentAgent="general"
                primaryAgents={PRIMARY_AGENTS}
                onSetAgent={() => undefined}
              />
            </div>
          </div>
        </DesktopTextProvider>
      </KeyboardShortcutProvider>
    </ThemeProvider>
  )
}

function createRunningFixture(kind: RunningFixtureKind) {
  const runStatus = kind === "permission"
    ? "waiting_permission"
    : kind === "queued"
      ? "queued"
      : "running"
  const run: DesktopRun = {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status: runStatus,
    createdAt: NOW,
    activeSkills: kind === "tool" ? ["browser"] : [],
  }
  const sessionSummary: DesktopSession = {
    id: SESSION_ID,
    title: `Running fixture: ${kind}`,
    workspaceRoot: "/fixtures/workspace",
    sessionId: SESSION_ID,
    createdAt: NOW,
    updatedAt: NOW,
    activeSkills: [],
    currentAgent: "general",
    latestRunStatus: runStatus,
  }
  const session: DesktopSessionSnapshot = {
    session: {
      id: SESSION_ID,
      activeSkills: sessionSummary.activeSkills,
      currentAgent: "general",
    },
    latestRun: run,
    activeRun: run,
    contextUsage: CONTEXT_USAGE,
    status: "busy",
  }

  return {
    sessionSummary,
    session,
    transcript: createTranscript(kind),
    permissionRequests: kind === "permission" ? [createPermissionRequest()] : [],
  }
}

function createTranscript(kind: RunningFixtureKind): DesktopTranscriptMessage[] {
  const transcript: DesktopTranscriptMessage[] = [
    createMessage("fixture-user-1", "user", "请检查长对话中，运行状态下输入栏、状态栏、thinking 与工具调用的视觉覆盖是否稳定。"),
    createMessage(
      "fixture-assistant-1",
      "assistant",
      [
        { type: "reasoning", text: "先确认输入栏底部遮罩、聊天记录宽度、状态栏间距，以及运行态控件是否保持实底。" },
        { type: "text", text: "我会保持在当前运行状态，方便观察 composer 和 transcript 的重叠边界。" },
      ],
    ),
    ...Array.from({ length: 18 }, (_, index) =>
      createMessage(
        `fixture-history-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `历史消息 ${String(index + 1).padStart(2, "0")}：这是一条用于制造滚动背景的长消息，保证内容会经过输入栏后方，从而能看出底部遮罩和宽度是否正确。`,
      ),
    ),
    createMessage("fixture-user-active", "user", getActivePrompt(kind), RUN_ID),
  ]

  const activeAssistant = createActiveAssistantMessage(kind)
  if (activeAssistant) {
    transcript.push(activeAssistant)
  }

  return transcript
}

function createActiveAssistantMessage(kind: RunningFixtureKind): DesktopTranscriptMessage | null {
  if (kind === "thinking" || kind === "queued") {
    return null
  }

  if (kind === "reasoning") {
    return createMessage(
      "fixture-assistant-active-reasoning",
      "assistant",
      [
        {
          type: "reasoning",
          text: "正在分析布局：输入栏应保持不透明，状态栏底部应由 paper 背景封住，聊天记录不应从输入栏两侧露出。",
        },
      ],
      RUN_ID,
    )
  }

  if (kind === "tool") {
    return createMessage(
      "fixture-assistant-active-tool",
      "assistant",
      [
        {
          type: "tool_call",
          toolName: "browser",
          callId: "fixture-tool-call",
          status: "pending",
          progress: "Inspecting bottom composer overlap and scroll position",
          toolInput: {
            url: "http://127.0.0.1:4173/?fixture=running-states",
          },
        },
      ],
      RUN_ID,
    )
  }

  return createMessage(
    "fixture-assistant-active-permission",
    "assistant",
    [
      {
        type: "tool_call",
        toolName: "shell",
        callId: "fixture-permission-tool-call",
        status: "pending",
        toolInput: {
          command: "bun run visual-check",
        },
      },
    ],
    RUN_ID,
  )
}

function getActivePrompt(kind: RunningFixtureKind) {
  if (kind === "thinking") {
    return "保持 fallback Thinking 状态，不要产生 reasoning 或 tool call。"
  }

  if (kind === "reasoning") {
    return "保持 live reasoning 区块展开，检查思考区域是否贴近输入栏。"
  }

  if (kind === "tool") {
    return "保持 tool running 状态，检查工具行与输入栏遮挡。"
  }

  if (kind === "permission") {
    return "保持 waiting permission 状态，检查 permission 是否占住输入栏。"
  }

  return "保持 queued 状态，检查发送后但尚未开始 streaming 的输入栏。"
}

function createPermissionRequest(): DesktopPermissionRequest {
  return {
    id: "fixture-permission",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    status: "pending",
    toolName: "shell",
    reason: "Run a visual verification command that would normally require user approval.",
    createdAt: NOW,
    resolvedAt: null,
  }
}

function createMessage(
  id: string,
  role: DesktopTranscriptMessage["role"],
  contentOrParts: string | MessagePart[],
  runId = `fixture-history-run-${id}`,
): DesktopTranscriptMessage {
  const parts = typeof contentOrParts === "string"
    ? undefined
    : contentOrParts
  const content = typeof contentOrParts === "string"
    ? contentOrParts
    : contentOrParts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")

  return {
    id,
    role,
    content,
    parts,
    createdAt: NOW,
    runId,
  }
}
