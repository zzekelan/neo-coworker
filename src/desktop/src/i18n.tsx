import { createContext, useContext, type ReactNode } from "react"
import type { DesktopLanguage } from "./desktop-settings"

type DesktopText = {
  sidebar: {
    workspace: string
    sessions: string
    newSession: string
    newWorkspace: string
    noSessions: string
    desktop: string
    online: string
    offline: string
    settings: string
    deleteSession: string
    deleteHint: string
    deleteBlocked: string
    running: string
    waiting: string
    failed: string
  }
  chat: {
    selectSession: string
    startConversation: string
    agentRunning: string
    waitingPermission: string
    thinking: string
    noActiveSkills: string
    filterSkills: string
    agentBusyPlaceholder: string
    askPlaceholder: string
    skills: string
  }
  skillPanel: {
    title: string
    subtitle: string
    locked: string
    noWorkspaceSkills: string
    noFilteredSkills: string
    active: string
    default: string
    start: string
    stop: string
    setDefault: string
  }
  permission: {
    title: string
    requestTool(toolName: string): string
    allow: string
    deny: string
  }
  message: {
    result: string
    error: string
    showMore: string
    showLess: string
  }
  settings: {
    title: string
    language: string
    provider: string
    providerUnset: string
    apiKey: string
    model: string
    baseUrl: string
    timeout: string
    timeoutHint: string
    externalHint: string
    apply: string
    applying: string
    stopRunsFirst: string
  }
}

const DESKTOP_TEXT: Record<DesktopLanguage, DesktopText> = {
  en: {
    sidebar: {
      workspace: "Workspace",
      sessions: "Sessions",
      newSession: "New",
      newWorkspace: "New workspace",
      noSessions: "No sessions found.",
      desktop: "Desktop",
      online: "Online",
      offline: "Offline",
      settings: "Settings",
      deleteSession: "Delete session",
      deleteHint: "Deletes this session together with its transcript, runs, and trace history.",
      deleteBlocked: "Stop the active run before deleting this session.",
      running: "Running",
      waiting: "Waiting",
      failed: "Failed",
    },
    chat: {
      selectSession: "Select a session to start",
      startConversation: "Start a conversation with NeoCoworker",
      agentRunning: "Agent Running",
      waitingPermission: "Waiting Permission",
      thinking: "NeoCoworker is thinking...",
      noActiveSkills: "No active skills",
      filterSkills: "Filter skills...",
      agentBusyPlaceholder: "Agent is busy...",
      askPlaceholder: "Ask NeoCoworker to do something...",
      skills: "Skills",
    },
    skillPanel: {
      title: "Skills",
      subtitle: "Browse and manage the active capabilities for this conversation.",
      locked: "Skill changes are locked while this run is active. Changes apply to future runs only.",
      noWorkspaceSkills: "No `.agents/skills` were found in this workspace.",
      noFilteredSkills: "No skills match this filter.",
      active: "Active",
      default: "Default",
      start: "Start",
      stop: "Stop",
      setDefault: "Set Default",
    },
    permission: {
      title: "Permission Required",
      requestTool(toolName: string) {
        return `The agent is requesting permission to execute ${toolName}.`
      },
      allow: "Allow",
      deny: "Deny",
    },
    message: {
      result: "Result",
      error: "Error",
      showMore: "Show more",
      showLess: "Show less",
    },
    settings: {
      title: "Settings",
      language: "Language",
      provider: "LLM provider",
      providerUnset: "Not configured",
      apiKey: "API key",
      model: "Model",
      baseUrl: "Base URL",
      timeout: "Timeout (ms)",
      timeoutHint: "Leave blank to use the provider default timeout.",
      externalHint: "This desktop is connected to an externally managed app-server, so LLM settings are view-only here.",
      apply: "Apply LLM Settings",
      applying: "Applying...",
      stopRunsFirst: "Stop active runs before applying LLM settings.",
    },
  },
  zh: {
    sidebar: {
      workspace: "工作区",
      sessions: "会话",
      newSession: "新建",
      newWorkspace: "新建工作区",
      noSessions: "还没有会话。",
      desktop: "桌面端",
      online: "在线",
      offline: "离线",
      settings: "设置",
      deleteSession: "删除会话",
      deleteHint: "会同时删除该会话的转录、runs 与 trace 历史。",
      deleteBlocked: "请先停止活动 run，再删除这个会话。",
      running: "运行中",
      waiting: "等待授权",
      failed: "失败",
    },
    chat: {
      selectSession: "选择一个会话开始",
      startConversation: "开始与 NeoCoworker 对话",
      agentRunning: "Agent 运行中",
      waitingPermission: "等待权限",
      thinking: "NeoCoworker 正在思考...",
      noActiveSkills: "当前没有启用的技能",
      filterSkills: "筛选技能...",
      agentBusyPlaceholder: "Agent 正忙...",
      askPlaceholder: "让 NeoCoworker 帮你做点什么...",
      skills: "技能",
    },
    skillPanel: {
      title: "技能",
      subtitle: "浏览并管理这段对话可用的能力。",
      locked: "当前 run 进行中，技能变更已锁定。现在的修改只会影响后续 run。",
      noWorkspaceSkills: "这个工作区下没有找到 `.agents/skills`。",
      noFilteredSkills: "没有匹配当前筛选条件的技能。",
      active: "已启用",
      default: "默认",
      start: "启用",
      stop: "停用",
      setDefault: "设为默认",
    },
    permission: {
      title: "需要权限",
      requestTool(toolName: string) {
        return `Agent 正在请求执行 ${toolName} 的权限。`
      },
      allow: "允许",
      deny: "拒绝",
    },
    message: {
      result: "结果",
      error: "错误",
      showMore: "展开",
      showLess: "收起",
    },
    settings: {
      title: "设置",
      language: "语言",
      provider: "LLM 提供商",
      providerUnset: "未设置",
      apiKey: "API Key",
      model: "模型",
      baseUrl: "Base URL",
      timeout: "超时（毫秒）",
      timeoutHint: "留空表示使用 provider 默认超时。",
      externalHint: "当前桌面端连接的是外部托管 app-server，因此这里只能查看 LLM 配置，不能修改。",
      apply: "应用 LLM 设置",
      applying: "应用中...",
      stopRunsFirst: "请先停止活动 run，再应用 LLM 设置。",
    },
  },
}

const DesktopTextContext = createContext<DesktopText>(DESKTOP_TEXT.en)

export function DesktopTextProvider(input: {
  language: DesktopLanguage
  children: ReactNode
}) {
  return (
    <DesktopTextContext.Provider value={DESKTOP_TEXT[input.language]}>
      {input.children}
    </DesktopTextContext.Provider>
  )
}

export function useDesktopText() {
  return useContext(DesktopTextContext)
}
