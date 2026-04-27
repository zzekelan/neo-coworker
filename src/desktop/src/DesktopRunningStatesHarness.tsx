import { useEffect, useMemo, useState } from "react"
import { ChatArea } from "./components/ChatArea"
import { DesktopTextProvider } from "./i18n"
import { KeyboardShortcutProvider } from "./providers/KeyboardShortcutProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import type { DesktopLanguage } from "./desktop-settings"
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
  | "reasoning"
  | "tool"
  | "permission"
  | "queued"

type ActivityDetailsPhase =
  | "streaming"
  | "tool-running"
  | "next-reasoning"

const FIXTURE_KINDS: Array<{
  kind: RunningFixtureKind
  label: string
  description: string
}> = [
  {
    kind: "reasoning",
    label: "Reasoning stream",
    description: "Live reasoning block expanded during an active run.",
  },
  {
    kind: "tool",
    label: "Running tool",
    description: "Active tool call keeps the composer locked without live reasoning.",
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

const ACTIVITY_REASONING_LINES_ZH = Array.from({ length: 28 }, (_, index) =>
  `步骤 ${String(index + 1).padStart(2, "0")}：持续追加 reasoning 内容，制造内部滚动区域，并确认最新输出会停在可视区域底部附近。`,
)

const ACTIVITY_REASONING_LINES_EN = Array.from({ length: 28 }, (_, index) =>
  `Step ${String(index + 1).padStart(2, "0")}: append reasoning content to force internal scrolling and keep the newest output near the bottom of the visible panel.`,
)

const LONG_TOOL_OUTPUT_ZH = Array.from({ length: 28 }, (_, index) =>
  `工具输出 ${String(index + 1).padStart(2, "0")}：这是一行很长的结果内容，用来确认 tool 详情区和推理内容一样使用左边线、内部滚动条和稳定的最大高度。`,
).join("\n")

const LONG_TOOL_OUTPUT_EN = Array.from({ length: 28 }, (_, index) =>
  `Tool output ${String(index + 1).padStart(2, "0")}: this long result line verifies that tool details use the same left-rail, internal scrollbar, and bounded height as reasoning content.`,
).join("\n")
const ACTIVITY_REASONING_DURATION_MS = 4200
const ACTIVITY_TOOL_RUNNING_HOLD_MS = 4200

export function DesktopRunningStatesHarness() {
  const [kind, setKind] = useState<RunningFixtureKind>("reasoning")
  const [language, setLanguage] = useState<DesktopLanguage>("zh")
  const fixture = useMemo(() => createRunningFixture(kind, language), [kind, language])

  return (
    <ThemeProvider theme="light" onThemeChange={() => {}}>
      <KeyboardShortcutProvider
        onNewSession={() => {}}
        onClearTranscript={() => {}}
        onCycleAgent={() => {}}
      >
        <DesktopTextProvider language={language}>
          <div className="flex h-screen w-full overflow-hidden bg-paper font-sans text-ink selection:bg-accent/20 selection:text-ink">
            <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-paper px-4 py-5">
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Desktop fixture
                </p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <h1 className="text-lg font-semibold text-ink">
                    Running states
                  </h1>
                  <div className="flex rounded-md border border-border bg-surface p-0.5">
                    {(["zh", "en"] as DesktopLanguage[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-label={`Switch fixture language to ${option === "zh" ? "Chinese" : "English"}`}
                        onClick={() => setLanguage(option)}
                        className={[
                          "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                          language === option
                            ? "bg-paper text-ink shadow-sm"
                            : "text-muted hover:text-ink",
                        ].join(" ")}
                      >
                        {option === "zh" ? "中文" : "EN"}
                      </button>
                    ))}
                  </div>
                </div>
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

export function DesktopActivityDetailsHarness() {
  const [language, setLanguage] = useState<DesktopLanguage>("zh")
  const reasoningLines = language === "zh" ? ACTIVITY_REASONING_LINES_ZH : ACTIVITY_REASONING_LINES_EN
  const [visibleLineCount, setVisibleLineCount] = useState(4)
  const [phase, setPhase] = useState<ActivityDetailsPhase>("streaming")

  useEffect(() => {
    setVisibleLineCount(4)
    setPhase("streaming")
  }, [language])

  useEffect(() => {
    if (phase !== "streaming") return

    if (visibleLineCount >= reasoningLines.length) {
      const finishTimer = window.setTimeout(() => {
        setPhase("tool-running")
      }, 600)
      return () => window.clearTimeout(finishTimer)
    }

    const appendTimer = window.setTimeout(() => {
      setVisibleLineCount((current) => Math.min(current + 1, reasoningLines.length))
    }, 300)

    return () => window.clearTimeout(appendTimer)
  }, [phase, reasoningLines.length, visibleLineCount])

  useEffect(() => {
    if (phase !== "tool-running") return

    const nextReasoningTimer = window.setTimeout(() => {
      setPhase("next-reasoning")
    }, ACTIVITY_TOOL_RUNNING_HOLD_MS)

    return () => window.clearTimeout(nextReasoningTimer)
  }, [phase])

  const fixture = useMemo(
    () => createActivityDetailsFixture(language, reasoningLines.slice(0, visibleLineCount).join("\n"), phase),
    [language, phase, reasoningLines, visibleLineCount],
  )

  const resetStreaming = () => {
    setVisibleLineCount(4)
    setPhase("streaming")
  }

  return (
    <ThemeProvider theme="light" onThemeChange={() => {}}>
      <KeyboardShortcutProvider
        onNewSession={() => {}}
        onClearTranscript={() => {}}
        onCycleAgent={() => {}}
      >
        <DesktopTextProvider language={language}>
          <div className="flex h-screen w-full overflow-hidden bg-paper font-sans text-ink selection:bg-accent/20 selection:text-ink">
            <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-paper px-4 py-5">
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Desktop fixture
                </p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <h1 className="text-lg font-semibold text-ink">
                    Activity details
                  </h1>
                  <div className="flex rounded-md border border-border bg-surface p-0.5">
                    {(["zh", "en"] as DesktopLanguage[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-label={`Switch fixture language to ${option === "zh" ? "Chinese" : "English"}`}
                        onClick={() => setLanguage(option)}
                        className={[
                          "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                          language === option
                            ? "bg-paper text-ink shadow-sm"
                            : "text-muted hover:text-ink",
                        ].join(" ")}
                      >
                        {option === "zh" ? "中文" : "EN"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-3 text-xs leading-5 text-muted">
                <p>
                  {language === "zh"
                    ? "这个 fixture 会持续追加 reasoning 内容；完成后先停留在 tool activity，再进入下一段 live reasoning 并收起前一段。"
                    : "This fixture appends reasoning content; after completion it holds on tool activity before entering the next live reasoning state and folding the prior activity."}
                </p>
                <p>
                  {language === "zh"
                    ? "展开下面的 tool 行，检查详情区是否像 reasoning 一样用内部滚动条。"
                    : "Expand the tool rows below to verify details use the same internal scrolling as reasoning."}
                </p>
                <button
                  type="button"
                  onClick={resetStreaming}
                  className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-paper"
                >
                  {language === "zh" ? "重播流式输出" : "Replay stream"}
                </button>
              </div>

              <div className="mt-auto rounded-lg border border-border bg-surface px-3 py-2.5 text-xs leading-5 text-muted">
                Open with <span className="font-mono text-ink">?fixture=activity-details</span>.
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
                permissionRequests={[]}
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

function createActivityDetailsFixture(language: DesktopLanguage, reasoningText: string, phase: ActivityDetailsPhase) {
  const run: DesktopRun = {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status: "running",
    createdAt: NOW,
    activeSkills: ["browser"],
  }
  const sessionSummary: DesktopSession = {
    id: SESSION_ID,
    title: "Activity details fixture",
    workspaceRoot: "/fixtures/workspace",
    sessionId: SESSION_ID,
    createdAt: NOW,
    updatedAt: NOW,
    activeSkills: ["browser"],
    currentAgent: "general",
    latestRunStatus: "running",
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
    transcript: createActivityDetailsTranscript(language, reasoningText, phase),
  }
}

function createRunningFixture(kind: RunningFixtureKind, language: DesktopLanguage) {
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
    transcript: createTranscript(kind, language),
    permissionRequests: kind === "permission" ? [createPermissionRequest()] : [],
  }
}

function createTranscript(kind: RunningFixtureKind, language: DesktopLanguage): DesktopTranscriptMessage[] {
  const transcript: DesktopTranscriptMessage[] = [
    createMessage("fixture-user-1", "user", language === "zh"
      ? "请检查长对话中，运行状态下输入栏、状态栏、reasoning 与工具调用的视觉覆盖是否稳定。"
      : "Check whether the composer, status bar, reasoning state, and tool activity stay visually stable in a long conversation."),
    createMessage(
      "fixture-assistant-1",
      "assistant",
      language === "zh"
        ? [
            { type: "reasoning", text: "先确认输入栏底部遮罩、聊天记录宽度、状态栏间距，以及运行态控件是否保持实底。" },
            { type: "text", text: "我会保持在当前运行状态，方便观察 composer 和 transcript 的重叠边界。" },
          ]
        : [
            { type: "reasoning", text: "First check the composer mask, transcript width, status-bar spacing, and whether running controls keep an opaque base." },
            { type: "text", text: "I will stay in the current running state so the composer and transcript boundary can be inspected." },
          ],
    ),
    ...Array.from({ length: 18 }, (_, index) =>
      createMessage(
        `fixture-history-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        language === "zh"
          ? `历史消息 ${String(index + 1).padStart(2, "0")}：这是一条用于制造滚动背景的长消息，保证内容会经过输入栏后方，从而能看出底部遮罩和宽度是否正确。`
          : `History message ${String(index + 1).padStart(2, "0")}: this long message creates a scrolling backdrop so content passes behind the composer and exposes bottom-mask or width issues.`,
      ),
    ),
    createMessage("fixture-user-active", "user", getActivePrompt(kind, language), RUN_ID),
  ]

  const activeAssistant = createActiveAssistantMessage(kind, language)
  if (activeAssistant) {
    transcript.push(activeAssistant)
  }

  return transcript
}

function createActivityDetailsTranscript(language: DesktopLanguage, reasoningText: string, phase: ActivityDetailsPhase): DesktopTranscriptMessage[] {
  const longOutput = language === "zh" ? LONG_TOOL_OUTPUT_ZH : LONG_TOOL_OUTPUT_EN
  const isStreaming = phase === "streaming"
  const activityParts: MessagePart[] = [
    {
      type: "reasoning",
      text: reasoningText,
      activityLabel: language === "zh" ? "模型调用" : "LLM call",
      durationMs: isStreaming ? undefined : ACTIVITY_REASONING_DURATION_MS,
    },
  ]

  if (!isStreaming) {
    activityParts.push(
      {
        type: "text",
        text: language === "zh"
          ? "我会先运行一组验证命令和浏览器检查，然后根据结果继续下一轮分析。"
          : "I will run a set of verification commands and browser checks, then continue with the next round of analysis.",
      },
      {
        type: "tool_call",
        toolName: "shell",
        callId: "activity-completed-shell-call",
        status: "success",
        toolInput: {
          command: "bun test test/desktop/message.test.ts --watch=false",
          reason: language === "zh"
            ? "生成足够长的 tool 输入详情，验证展开后内部滚动条。"
            : "Generate enough tool input detail to verify internal scrolling after expansion.",
        },
      },
      {
        type: "tool_result",
        callId: "activity-completed-shell-call",
        result: {
          stdout: longOutput,
        },
      },
      {
        type: "tool_call",
        toolName: "browser",
        callId: "activity-browser-call",
        status: phase === "tool-running" ? "pending" : "success",
        progress: language === "zh"
          ? "展开本行查看长 URL 和长输出区域"
          : "Expand this row to inspect long URL and output details",
        toolInput: {
          url: "http://127.0.0.1:4173/?fixture=activity-details&very-long-query=reasoning-scroll-tool-details",
          reason: language === "zh"
            ? "完成的工具也应该复用 reasoning 风格的左边线详情区，并带内部滚动条。"
            : "Completed tools should reuse the reasoning-style left-rail details area with internal scrolling.",
        },
      },
    )

    if (phase === "next-reasoning") {
      activityParts.push({
        type: "tool_result",
        callId: "activity-browser-call",
        result: {
          output: longOutput,
        },
      }, {
        type: "reasoning",
        text: language === "zh"
          ? [
              "第二轮 reasoning 正在开始：上一轮的推理、说明文字和工具活动应该在这一段出现 2 秒后折叠为外层运行摘要。",
              "这一段保持展开，继续展示正在思考的流式内容。",
            ].join("\n")
          : [
              "Second reasoning pass is starting: the prior reasoning, explanation text, and tool activity should fold into an outer run summary two seconds after this appears.",
              "This pass stays expanded and continues showing live reasoning content.",
            ].join("\n"),
      })
    }
  }

  return [
    createMessage("activity-user-1", "user", language === "zh"
      ? "请验证 reasoning 内容持续输出时会自动滚到最新；下一段 live reasoning 开始时，前一段会收起成“已运行模型调用（时长）”，并检查 tool 详情滚动区域。"
      : "Verify that reasoning output follows the newest content; when the next live reasoning state starts, the prior activity folds into “Ran LLM call (duration)”, and tool details scroll internally."),
    ...Array.from({ length: 12 }, (_, index) =>
      createMessage(
        `activity-history-${index}`,
        index % 2 === 0 ? "assistant" : "user",
        language === "zh"
          ? `背景消息 ${String(index + 1).padStart(2, "0")}：制造足够长的对话，让 activity details fixture 更接近真实长会话。`
          : `Background message ${String(index + 1).padStart(2, "0")}: this makes the activity details fixture behave more like a long real chat.`,
      ),
    ),
    createMessage(
      "activity-assistant-live",
      "assistant",
      activityParts,
      RUN_ID,
    ),
  ]
}

function createActiveAssistantMessage(kind: RunningFixtureKind, language: DesktopLanguage): DesktopTranscriptMessage | null {
  if (kind === "queued") {
    return null
  }

  if (kind === "reasoning") {
    return createMessage(
      "fixture-assistant-active-reasoning",
      "assistant",
      [
        {
          type: "reasoning",
          text: language === "zh"
            ? "正在分析布局：输入栏应保持不透明，状态栏底部应由 paper 背景封住，聊天记录不应从输入栏两侧露出。"
            : "Analyzing layout: the composer should stay opaque, the status bar should have a paper base, and transcript text should not leak around the composer sides.",
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
          callId: "fixture-completed-browser-call",
          status: "success",
          toolInput: {
            url: "http://127.0.0.1:4173/?fixture=running-states",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-browser-call",
          result: {
            output: "Verified composer and transcript bounds before the live tool step.",
          },
        },
        {
          type: "tool_call",
          toolName: "browser",
          callId: "fixture-running-browser-call",
          status: "pending",
          progress: language === "zh"
            ? "检查输入栏底部重叠和滚动位置"
            : "Inspecting bottom composer overlap and scroll position",
          toolInput: {
            url: "http://127.0.0.1:4173/?fixture=running-states",
          },
        },
        {
          type: "tool_call",
          toolName: "shell",
          callId: "fixture-completed-shell-call",
          status: "success",
          toolInput: {
            command: "bun test test/desktop/tool-progress.test.ts",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-shell-call",
          result: {
            stdout: "9 pass",
          },
        },
        {
          type: "tool_call",
          toolName: "shell",
          callId: "fixture-running-shell-call",
          status: "pending",
          progress: language === "zh"
            ? "运行桌面视觉检查"
            : "Running desktop visual checks",
          toolInput: {
            command: "bun run check",
          },
        },
        {
          type: "tool_call",
          toolName: "read",
          callId: "fixture-completed-read-call",
          status: "success",
          toolInput: {
            path: "src/desktop/src/components/Message.tsx",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-read-call",
          result: {
            output: "Read Message.tsx for tool activity row styling.",
          },
        },
        {
          type: "tool_call",
          toolName: "read",
          callId: "fixture-running-read-call",
          status: "pending",
          progress: language === "zh"
            ? "读取桌面视觉 harness 文档"
            : "Reading the desktop visual harness docs",
          toolInput: {
            path: "docs/dev/DESKTOP_VISUAL_HARNESS.md",
          },
        },
        {
          type: "tool_call",
          toolName: "websearch",
          callId: "fixture-completed-websearch-call",
          status: "success",
          toolInput: {
            query: "desktop agent tool activity UI",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-websearch-call",
          result: {
            output: "Found reference patterns for compact running activity rows.",
          },
        },
        {
          type: "tool_call",
          toolName: "websearch",
          callId: "fixture-running-websearch-call",
          status: "pending",
          progress: language === "zh"
            ? "查找当前设计参考"
            : "Searching for current design references",
          toolInput: {
            query: "desktop agent tool activity UI",
          },
        },
        {
          type: "tool_call",
          toolName: "skill",
          callId: "fixture-completed-skill-call",
          status: "success",
          toolInput: {
            name: "browser",
            action: "activate",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-skill-call",
          result: {
            output: "Activated skill browser",
          },
        },
        {
          type: "tool_call",
          toolName: "skill",
          callId: "fixture-running-skill-call",
          status: "pending",
          progress: language === "zh"
            ? "激活 frontend 技能"
            : "Activating the frontend skill",
          toolInput: {
            name: "frontend",
            action: "activate",
          },
        },
        {
          type: "tool_call",
          toolName: "agent",
          callId: "fixture-completed-agent-call",
          status: "success",
          toolInput: {
            agent: "reviewer",
            prompt: "Review running tool visual alignment",
          },
        },
        {
          type: "tool_result",
          callId: "fixture-completed-agent-call",
          result: {
            output: "Spawned reviewer subagent",
          },
        },
        {
          type: "tool_call",
          toolName: "agent",
          callId: "fixture-running-agent-call",
          status: "pending",
          progress: language === "zh"
            ? "派遣视觉审查子代理"
            : "Delegating visual review to subagent",
          toolInput: {
            agent: "reviewer",
            prompt: "Compare completed and running tool rows",
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

function getActivePrompt(kind: RunningFixtureKind, language: DesktopLanguage) {
  if (kind === "reasoning") {
    return language === "zh"
      ? "保持 live reasoning 区块展开，检查思考区域是否贴近输入栏。"
      : "Keep the live reasoning block expanded and check how close it sits to the composer."
  }

  if (kind === "tool") {
    return language === "zh"
      ? "保持 tool running 状态，检查工具行与输入栏遮挡。"
      : "Keep the tool running state and check the tool row against the composer mask."
  }

  if (kind === "permission") {
    return language === "zh"
      ? "保持 waiting permission 状态，检查 permission 是否占住输入栏。"
      : "Keep the waiting permission state and check whether permission occupies the composer."
  }

  return language === "zh"
    ? "保持 queued 状态，检查发送后但尚未开始 streaming 的输入栏。"
    : "Keep the queued state and check the composer after send but before streaming begins."
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
