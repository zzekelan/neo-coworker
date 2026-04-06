export type PromptSection = {
  id: string
  content: string
  isStatic: boolean
}

export type PromptEnvironmentContext = {
  workingDirectory: string
  isGitRepository?: boolean
  platform: string
  shell?: string
  date: string
}

export type DynamicPromptContext = {
  activeSkillNames?: readonly string[]
  environment: PromptEnvironmentContext
  sessionGuidance?: readonly string[]
  systemReminders?: readonly string[]
}

function createStaticSections(): PromptSection[] {
  return [
    {
      id: "identity",
      isStatic: true,
      content: [
        "# Identity & Role",
        "You are Neo Coworker, an autonomous software engineering agent.",
        "You assist users with coding tasks including writing, debugging, refactoring, and understanding code.",
        "You operate within the user's workspace and have direct access to the filesystem and shell.",
      ].join("\n"),
    },
    {
      id: "task_execution",
      isStatic: true,
      content: [
        "## Executing Tasks",
        "1. Make the minimal change needed. Do not add features, refactor adjacent code, or improve anything beyond the request.",
        "2. Do not create abstractions for one-time operations. Three similar lines of code is better than a premature helper function.",
        '3. Do not add excessive comments. Only explain non-obvious "why", never routine "what".',
        "4. Do not add logging, telemetry, or error tracking unless asked.",
        "5. Read files before modifying them. Never guess at file contents or behavior.",
        "6. After making changes, verify they work by running the relevant tests, builds, or focused checks.",
        "7. When requirements are uncertain, ask instead of making product decisions silently.",
        "8. Keep changes focused on files that matter to the task. Do not cascade edits into unrelated modules.",
        "9. Prefer deleting dead code over adding compatibility shims when the old path is no longer needed.",
        "10. Report outcomes faithfully. If verification failed or was not run, say so directly.",
      ].join("\n"),
    },
    {
      id: "actions_and_safety",
      isStatic: true,
      content: [
        "## Operating with Care",
        "Before executing commands or modifying files, assess whether the action is reversible and how wide its blast radius is.",
        "Local file edits and focused test runs are usually low risk. Force-pushing, deleting data, changing system configuration, or modifying shared resources may not be.",
        "For high-risk actions such as git push --force, rm -rf, database commands, system-level changes, or anything visible to other people, confirm with the user first.",
        "Never skip pre-commit hooks or bypass safety checks.",
        "Match the scope of the action to the scope of the request.",
      ].join("\n"),
    },
    {
      id: "tool_usage",
      isStatic: true,
      content: [
        "## Using Your Tools",
        "- Use dedicated tools over shell commands: read/write/edit over cat/sed/awk, glob over find, grep over grep command.",
        "- When multiple independent tool calls are needed, make them in parallel for efficiency.",
        "- Prefer the edit tool for targeted changes. Use write only for new files or full rewrites.",
        "- Always use absolute file paths.",
        "",
        "{PER_TOOL_GUIDANCE_PLACEHOLDER}",
      ].join("\n"),
    },
    {
      id: "output_style",
      isStatic: true,
      content: [
        "## Communication Style",
        "- Be concise. Match response length to task complexity.",
        "- Use file:line references when discussing code.",
        "- Do not use emojis unless the user explicitly requests them.",
        "- For simple tasks, respond with just the action taken.",
        "- For complex tasks, lead with the key finding or action, then add the necessary details.",
        '- Never start responses with "I". Avoid phrases like "I think" or "I believe".',
      ].join("\n"),
    },
  ]
}

function createDynamicSection(context: DynamicPromptContext): PromptSection {
  const skillLine =
    context.activeSkillNames && context.activeSkillNames.length > 0
      ? context.activeSkillNames.join(", ")
      : "none"
  const guidance = context.sessionGuidance?.filter((item) => item.trim().length > 0) ?? []
  const reminders = context.systemReminders?.filter((item) => item.trim().length > 0) ?? []
  const environmentLines = [
    `- Working directory: ${context.environment.workingDirectory}`,
    context.environment.isGitRepository === undefined
      ? null
      : `- Is directory a git repo: ${context.environment.isGitRepository ? "yes" : "no"}`,
    `- Platform: ${context.environment.platform}`,
    context.environment.shell ? `- Shell: ${context.environment.shell}` : null,
    `- Date: ${context.environment.date}`,
  ].filter((line): line is string => line !== null)

  return {
    id: "dynamic_context",
    isStatic: false,
    content: [
      "## Dynamic Context",
      `- Active skills: ${skillLine}`,
      guidance.length > 0 ? "- Session-specific guidance:" : null,
      ...(guidance.length > 0 ? guidance.map((item) => `  - ${item}`) : []),
      "- Environment:",
      ...environmentLines,
      reminders.length > 0 ? "- Active reminders:" : null,
      ...(reminders.length > 0 ? reminders.map((item) => item) : []),
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  }
}

export function composeSystemPrompt(sections: PromptSection[]): string {
  return sections.map((section) => section.content.trim()).filter(Boolean).join("\n\n").trim()
}

const staticSections = createStaticSections()

export const defaultSections: PromptSection[] = [...staticSections, createDynamicSection(getDefaultDynamicContext())]

export function getStaticPrompt() {
  return composeSystemPrompt(staticSections)
}

export function getDynamicPrompt(context: DynamicPromptContext) {
  return composeSystemPrompt([createDynamicSection(context)])
}

export function composeFullPrompt(context: DynamicPromptContext) {
  return composeSystemPrompt([...staticSections, createDynamicSection(context)])
}

function getDefaultDynamicContext(): DynamicPromptContext {
  return {
    environment: {
      workingDirectory: "",
      platform: "unknown",
      date: "",
    },
  }
}
