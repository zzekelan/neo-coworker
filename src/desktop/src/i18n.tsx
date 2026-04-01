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
    createSessionToStart: string
    createSession: string
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
    viewDetails: string
    hideDetails: string
    running: string
    completed: string
    failed: string
    cancelled: string
    noAdditionalDetails: string
    details: string
    output: string
    errorDetails: string
    additionalData: string
    items: string
    workspace: string
    usingTool(toolName: string): string
    toolWorking: string
    readingFile: string
    writingFile: string
    editingFile: string
    runningCommand: string
    searchingWeb: string
    openingWebpage: string
    searchingCodebase: string
    scanningFiles: string
    findingMatchingFiles: string
    updatingSkills: string
    commandDidNotComplete: string
    fileActionDidNotComplete: string
    toolActionDidNotComplete: string
    fileReady: string
    fileUpdated: string
    editApplied: string
    commandFinished: string
    searchFinished: string
    pageLoaded: string
    codeSearchFinished: string
    skillsUpdated: string
    toolFinished: string
    openingFileContents: string
    savingFileChanges: string
    applyingFocusedEdit: string
    executingShellCommand: string
    lookingUpWebInfo: string
    loadingWebpage: string
    searchingRepoCode: string
    scanningMatchingText: string
    lookingForMatchingFiles: string
    toolReturnedError: string
    fileContentReady: string
    fileChangeApplied: string
    commandCompleted: string
    toolCompleted: string
    openingPath(path: string): string
    savingPath(path: string): string
    editingPath(path: string): string
    runningCommandText(command: string): string
    searchingFor(query: string): string
    openingUrl(url: string): string
    lookingForCode(query: string): string
    findingMatches(query: string): string
    returnedItems(count: number): string
    returnedNamedItems(count: number, singular: string, plural: string): string
  }
  settings: {
    title: string
    close: string
    general: string
    llm: string
    storagePath: string
    language: string
    provider: string
    providerUnset: string
    apiKey: string
    model: string
    baseUrl: string
    timeout: string
    timeoutHint: string
    externalHint: string
    applyGeneral: string
    applyLlm: string
    applying: string
    appliedGeneral: string
    appliedLlm: string
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
      createSessionToStart: "New a session to start",
      createSession: "New Session",
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
      viewDetails: "View details",
      hideDetails: "Hide details",
      running: "In progress",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      noAdditionalDetails: "No additional details.",
      details: "Details",
      output: "Output",
      errorDetails: "Error details",
      additionalData: "Additional data",
      items: "Items",
      workspace: "Workspace",
      usingTool(toolName: string) {
        return `Using ${toolName}`
      },
      toolWorking: "Working with a tool.",
      readingFile: "Reading file",
      writingFile: "Writing file",
      editingFile: "Editing file",
      runningCommand: "Running command",
      searchingWeb: "Searching the web",
      openingWebpage: "Opening webpage",
      searchingCodebase: "Searching codebase",
      scanningFiles: "Scanning files",
      findingMatchingFiles: "Finding matching files",
      updatingSkills: "Updating skills",
      commandDidNotComplete: "Command did not complete",
      fileActionDidNotComplete: "File action did not complete",
      toolActionDidNotComplete: "Tool action did not complete",
      fileReady: "File ready",
      fileUpdated: "File updated",
      editApplied: "Edit applied",
      commandFinished: "Command finished",
      searchFinished: "Search finished",
      pageLoaded: "Page loaded",
      codeSearchFinished: "Code search finished",
      skillsUpdated: "Skills updated",
      toolFinished: "Tool finished",
      openingFileContents: "Opening a file to inspect its contents.",
      savingFileChanges: "Saving changes to a file.",
      applyingFocusedEdit: "Applying a focused edit.",
      executingShellCommand: "Executing a shell command.",
      lookingUpWebInfo: "Looking up information on the web.",
      loadingWebpage: "Loading a webpage.",
      searchingRepoCode: "Searching the repository for matching code.",
      scanningMatchingText: "Scanning files for matching text.",
      lookingForMatchingFiles: "Looking for files that match a pattern.",
      toolReturnedError: "The tool returned an error.",
      fileContentReady: "The file content is ready.",
      fileChangeApplied: "The requested file change was applied.",
      commandCompleted: "The command completed.",
      toolCompleted: "The tool completed successfully.",
      openingPath(path: string) {
        return `Opening ${path}.`
      },
      savingPath(path: string) {
        return `Saving changes to ${path}.`
      },
      editingPath(path: string) {
        return `Editing ${path}.`
      },
      runningCommandText(command: string) {
        return `Running \`${command}\`.`
      },
      searchingFor(query: string) {
        return `Searching for "${query}".`
      },
      openingUrl(url: string) {
        return `Opening ${url}.`
      },
      lookingForCode(query: string) {
        return `Looking for "${query}" in the codebase.`
      },
      findingMatches(query: string) {
        return `Finding matches for "${query}".`
      },
      returnedItems(count: number) {
        return count === 1 ? "Returned 1 item." : `Returned ${count} items.`
      },
      returnedNamedItems(count: number, singular: string, plural: string) {
        return count === 1 ? `Returned 1 ${singular}.` : `Returned ${count} ${plural}.`
      },
    },
    settings: {
      title: "Settings",
      close: "Close",
      general: "General",
      llm: "LLM Settings",
      storagePath: "Stored in .agents/desktop-settings.json",
      language: "Language",
      provider: "LLM provider",
      providerUnset: "Not configured",
      apiKey: "API key",
      model: "Model",
      baseUrl: "Base URL",
      timeout: "Timeout (ms)",
      timeoutHint: "Leave blank to use the provider default timeout.",
      externalHint: "This desktop is connected to an externally managed app-server, so LLM settings are view-only here.",
      applyGeneral: "Apply General Settings",
      applyLlm: "Apply LLM Settings",
      applying: "Applying...",
      appliedGeneral: "General settings applied successfully.",
      appliedLlm: "LLM settings applied successfully.",
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
      createSessionToStart: "新建一个会话以开始",
      createSession: "新建会话",
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
      viewDetails: "查看详情",
      hideDetails: "收起详情",
      running: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      noAdditionalDetails: "没有更多详情。",
      details: "详情",
      output: "输出",
      errorDetails: "错误详情",
      additionalData: "附加数据",
      items: "条目",
      workspace: "工作区",
      usingTool(toolName: string) {
        return `使用 ${toolName}`
      },
      toolWorking: "正在使用工具处理。",
      readingFile: "正在读取文件",
      writingFile: "正在写入文件",
      editingFile: "正在编辑文件",
      runningCommand: "正在运行命令",
      searchingWeb: "正在搜索网页",
      openingWebpage: "正在打开网页",
      searchingCodebase: "正在搜索代码库",
      scanningFiles: "正在扫描文件",
      findingMatchingFiles: "正在查找匹配文件",
      updatingSkills: "正在更新技能",
      commandDidNotComplete: "命令未成功完成",
      fileActionDidNotComplete: "文件操作未成功完成",
      toolActionDidNotComplete: "工具操作未成功完成",
      fileReady: "文件已准备好",
      fileUpdated: "文件已更新",
      editApplied: "修改已应用",
      commandFinished: "命令已完成",
      searchFinished: "搜索已完成",
      pageLoaded: "页面已加载",
      codeSearchFinished: "代码搜索已完成",
      skillsUpdated: "技能已更新",
      toolFinished: "工具已完成",
      openingFileContents: "正在打开文件并查看内容。",
      savingFileChanges: "正在把更改保存到文件。",
      applyingFocusedEdit: "正在应用一次定向修改。",
      executingShellCommand: "正在执行 shell 命令。",
      lookingUpWebInfo: "正在从网页检索信息。",
      loadingWebpage: "正在加载网页。",
      searchingRepoCode: "正在仓库中搜索匹配的代码。",
      scanningMatchingText: "正在扫描文件中的匹配文本。",
      lookingForMatchingFiles: "正在查找符合模式的文件。",
      toolReturnedError: "工具返回了错误。",
      fileContentReady: "文件内容已就绪。",
      fileChangeApplied: "请求的文件更改已应用。",
      commandCompleted: "命令已完成。",
      toolCompleted: "工具已成功完成。",
      openingPath(path: string) {
        return `正在打开 ${path}。`
      },
      savingPath(path: string) {
        return `正在将更改保存到 ${path}。`
      },
      editingPath(path: string) {
        return `正在编辑 ${path}。`
      },
      runningCommandText(command: string) {
        return `正在运行 \`${command}\`。`
      },
      searchingFor(query: string) {
        return `正在搜索“${query}”。`
      },
      openingUrl(url: string) {
        return `正在打开 ${url}。`
      },
      lookingForCode(query: string) {
        return `正在代码库中查找“${query}”。`
      },
      findingMatches(query: string) {
        return `正在查找“${query}”的匹配项。`
      },
      returnedItems(count: number) {
        return count === 1 ? "返回了 1 条结果。" : `返回了 ${count} 条结果。`
      },
      returnedNamedItems(count: number, singular: string, plural: string) {
        return count === 1 ? `返回了 1 个${singular}。` : `返回了 ${count} 个${plural}。`
      },
    },
    settings: {
      title: "设置",
      close: "关闭",
      general: "通用",
      llm: "LLM 设置",
      storagePath: "存储于 .agents/desktop-settings.json",
      language: "语言",
      provider: "LLM 提供商",
      providerUnset: "未设置",
      apiKey: "API Key",
      model: "模型",
      baseUrl: "Base URL",
      timeout: "超时（毫秒）",
      timeoutHint: "留空表示使用 provider 默认超时。",
      externalHint: "当前桌面端连接的是外部托管 app-server，因此这里只能查看 LLM 配置，不能修改。",
      applyGeneral: "应用通用设置",
      applyLlm: "应用 LLM 设置",
      applying: "应用中...",
      appliedGeneral: "通用设置已成功应用。",
      appliedLlm: "LLM 设置已成功应用。",
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
