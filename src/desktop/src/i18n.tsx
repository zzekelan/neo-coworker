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
    today: string
    yesterday: string
    earlier: string
  }
  chat: {
    selectSession: string
    startConversation: string
    createSessionToStart: string
    readyInWorkspace(workspace: string, agent: string): string
    createSession: string
    agentRunning: string
    waitingPermission: string
    thinking: string
    noActiveSkills: string
    filterSkills: string
    agentBusyPlaceholder: string
    askPlaceholder: string
    skills: string
    contextUsed(percent: number): string
    sessionCompacted: string
    compactionSaved(tokensBefore: number, tokensAfter: number): string
    send: string
    newLine: string
    runStatusRunning: string
    runStatusWaiting: string
    runStatusFailed: string
    runStatusCancelled: string
    runFinishedFailed: string
    runFinishedCancelled: string
    copied: string
    copyMessage: string
    clipboardUnavailable: string
  }
  skillPanel: {
    title: string
    subtitle: string
    locked: string
    noWorkspaceSkills: string
    noFilteredSkills: string
    active: string
    start: string
    cancel: string
    cancelPending: string
  }
  permission: {
    title: string
    requestTool(toolName: string): string
    allow: string
    deny: string
    patchPreviewMissingTitle: string
    patchPreviewMissingBody: string
    patchFilesChanged(files: number, additions: number, deletions: number): string
  }
  message: {
    result: string
    error: string
    showMore: string
    showLess: string
    viewDetails: string
    hideDetails: string
    thinking: string
    running: string
    waitingPermission: string
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
    completedRead(detail: string): string
    completedReadFallback: string
    completedWrote(detail: string): string
    completedWroteFallback: string
    completedEdited(detail: string): string
    completedEditedFallback: string
    completedRan(detail: string): string
    completedRanFallback: string
    completedSearched(detail: string): string
    completedSearchedFallback: string
    completedFetched(detail: string): string
    completedFetchedFallback: string
    completedCodeSearch(detail: string): string
    completedCodeSearchFallback: string
    completedScanned(detail: string): string
    completedScannedFallback: string
    completedFound(detail: string): string
    completedFoundFallback: string
    spawningSubagent: string
    delegatingTask: string
    completedAgent(detail: string): string
    completedAgentFallback: string
    completedGenericTool(name: string, detail: string): string
    completedSkillActivation(name: string): string
    completedSkillList: string
    completedSkills: string
    completedActivity(label: string, duration: string | null): string
    completedRunActivity(duration: string | null, toolNames: string[]): string
    formatDuration(durationMs: number): string
    llmCall: string
    cancelledSuffix: string
    failedSuffix: string
    reasoning: string
  }
  settings: {
    title: string
    close: string
    general: string
    llm: string
    storagePath: string
    language: string
    appearance: string
    theme: string
    themeDark: string
    themeLight: string
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
    reasoning: string
    reasoningThinking: string
    reasoningThinkingOn: string
    reasoningThinkingOff: string
    reasoningEffort: string
    reasoningEffortDefault: string
    reasoningEffortLow: string
    reasoningEffortMedium: string
    reasoningEffortHigh: string
    reasoningUnknownModelWarning: string
  }
  compatibility: {
    legacySessionTitle: string
    legacySessionMessage: string
    continueWithoutThinking: string
    continueWithoutThinkingHint: string
    startNewSession: string
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
      deleteHint: "Deletes this session together with its timeline, runs, and trace history.",
      deleteBlocked: "Stop the active run before deleting this session.",
      running: "Running",
      waiting: "Waiting",
      failed: "Failed",
      today: "Today",
      yesterday: "Yesterday",
      earlier: "Earlier",
    },
    chat: {
      selectSession: "Select a session to start",
      startConversation: "Start a conversation with NeoCoworker",
      createSessionToStart: "Start a new session",
      readyInWorkspace(workspace: string, agent: string) {
        return `Ready in ${workspace} with ${agent}.`
      },
      createSession: "New Session",
      agentRunning: "Agent Running",
      waitingPermission: "Waiting Permission",
      thinking: "NeoCoworker is thinking...",
      noActiveSkills: "No active skills",
      filterSkills: "Filter skills...",
      agentBusyPlaceholder: "NeoCoworker is busy...",
      askPlaceholder: "Ask NeoCoworker to do something...",
      skills: "Skills",
      contextUsed(percent: number) {
        return `${percent}% context used`
      },
      sessionCompacted: "Context compacted",
      compactionSaved(tokensBefore: number, tokensAfter: number) {
        const saved = tokensBefore - tokensAfter
        return `${saved.toLocaleString()} tokens freed`
      },
      send: "Send",
      newLine: "New line",
      runStatusRunning: "Running",
      runStatusWaiting: "Waiting",
      runStatusFailed: "Failed",
      runStatusCancelled: "Cancelled",
      runFinishedFailed: "Run failed",
      runFinishedCancelled: "Run cancelled",
      copied: "Copied!",
      copyMessage: "Copy message",
      clipboardUnavailable: "Clipboard unavailable",
    },
    skillPanel: {
      title: "Skills",
      subtitle: "Browse and manage the active capabilities for this conversation.",
      locked: "Skill changes are locked while this run is active. Changes apply to future runs only.",
      noWorkspaceSkills: "No `.ncoworker/skills` were found in this workspace.",
      noFilteredSkills: "No skills match this filter.",
      active: "Active",
      start: "Start",
      cancel: "Cancel",
      cancelPending: "Skill instructions haven't been sent yet. Cancel to remove it.",
    },
    permission: {
      title: "Permission Required",
      requestTool(toolName: string) {
        return `The agent is requesting permission to execute ${toolName}.`
      },
      allow: "Allow",
      deny: "Deny",
      patchPreviewMissingTitle: "Patch preview unavailable",
      patchPreviewMissingBody: "Only the durable file summary is available. Review the listed files carefully before approving.",
      patchFilesChanged(files: number, additions: number, deletions: number) {
        return `${files} file${files === 1 ? "" : "s"} changed, +${additions}/-${deletions}`
      },
    },
    message: {
      result: "Result",
      error: "Error",
      showMore: "Show more",
      showLess: "Show less",
      viewDetails: "View details",
      hideDetails: "Hide details",
      thinking: "Thinking",
      running: "In progress",
      waitingPermission: "Waiting for permission",
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
      updatingSkills: "Activating skills",
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
      skillsUpdated: "Skills activated",
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
      completedRead(detail: string) { return `Read ${detail}` },
      completedReadFallback: "Read file",
      completedWrote(detail: string) { return `Wrote ${detail}` },
      completedWroteFallback: "Wrote file",
      completedEdited(detail: string) { return `Edited ${detail}` },
      completedEditedFallback: "Edited file",
      completedRan(detail: string) { return `Ran ${detail}` },
      completedRanFallback: "Ran command",
      completedSearched(detail: string) { return `Searched "${detail}"` },
      completedSearchedFallback: "Searched the web",
      completedFetched(detail: string) { return `Fetched ${detail}` },
      completedFetchedFallback: "Fetched webpage",
      completedCodeSearch(detail: string) { return `Found ${detail}` },
      completedCodeSearchFallback: "Searched codebase",
      completedScanned(detail: string) { return `Scanned ${detail}` },
      completedScannedFallback: "Scanned files",
      completedFound(detail: string) { return `Found ${detail}` },
      completedFoundFallback: "Found matching files",
      spawningSubagent: "Spawning subagent",
      delegatingTask: "Delegating task to subagent",
      completedAgent(detail: string) { return `Spawned ${detail} subagent` },
      completedAgentFallback: "Spawned subagent",
      completedGenericTool(name: string, detail: string) { return `${name}: ${detail}` },
      completedSkillActivation(name: string) { return `Activated ${name}` },
      completedSkillList: "Listed skills",
      completedSkills: "Updated skills",
      completedActivity(label: string, duration: string | null) {
        return duration ? `Ran ${label} (${duration})` : `Ran ${label}`
      },
      completedRunActivity(duration: string | null, toolNames: string[]) {
        const ranText = duration ? `Ran ${duration}` : "Ran activity"
        if (toolNames.length === 0) return ranText
        const toolText = toolNames.join(", ")
        return `${ranText}; called ${toolText} ${toolNames.length === 1 ? "tool" : "tools"}`
      },
      formatDuration(durationMs: number) {
        return `${(durationMs / 1000).toFixed(1)}s`
      },
      llmCall: "LLM call",
      cancelledSuffix: "(cancelled)",
      failedSuffix: "failed",
      reasoning: "Reasoning",
    },
    settings: {
      title: "Settings",
      close: "Close",
      general: "General",
      llm: "LLM Settings",
      storagePath: "Stored in .ncoworker/desktop-settings.json",
      language: "Language",
      appearance: "Appearance",
      theme: "Theme",
      themeDark: "Dark",
      themeLight: "Light",
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
      reasoning: "Reasoning",
      reasoningThinking: "Enable thinking",
      reasoningThinkingOn: "On",
      reasoningThinkingOff: "Off",
      reasoningEffort: "Reasoning effort",
      reasoningEffortDefault: "Default",
      reasoningEffortLow: "Low",
      reasoningEffortMedium: "Medium",
      reasoningEffortHigh: "High",
      reasoningUnknownModelWarning: "Model not found in models.dev catalog. Reasoning controls below are manual overrides.",
    },
    compatibility: {
      legacySessionTitle: "Session compatibility",
      legacySessionMessage:
        "This session was created before reasoning support, so it can't continue with thinking enabled. Choose how to proceed.",
      continueWithoutThinking: "Continue without thinking",
      continueWithoutThinkingHint:
        "Thinking stays off for this session until you re-enable it in settings or start a new session.",
      startNewSession: "Start new session",
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
      today: "今天",
      yesterday: "昨天",
      earlier: "更早",
    },
    chat: {
      selectSession: "选择一个会话开始",
      startConversation: "开始与 NeoCoworker 对话",
      createSessionToStart: "开始一个新会话",
      readyInWorkspace(workspace: string, agent: string) {
        return `${workspace} 已就绪，当前使用 ${agent}。`
      },
      createSession: "新建会话",
      agentRunning: "Agent 运行中",
      waitingPermission: "等待权限",
      thinking: "NeoCoworker 正在思考...",
      noActiveSkills: "当前没有启用的技能",
      filterSkills: "筛选技能...",
      agentBusyPlaceholder: "NeoCoworker 正忙...",
      askPlaceholder: "让 NeoCoworker 帮你做点什么...",
      skills: "技能",
      contextUsed(percent: number) {
        return `已使用 ${percent}% 上下文`
      },
      sessionCompacted: "上下文已压缩",
      compactionSaved(tokensBefore: number, tokensAfter: number) {
        const saved = tokensBefore - tokensAfter
        return `释放了 ${saved.toLocaleString()} 个 token`
      },
      send: "发送",
      newLine: "换行",
      runStatusRunning: "运行中",
      runStatusWaiting: "等待中",
      runStatusFailed: "失败",
      runStatusCancelled: "已取消",
      runFinishedFailed: "运行失败",
      runFinishedCancelled: "运行已取消",
      copied: "已复制！",
      copyMessage: "复制消息",
      clipboardUnavailable: "剪贴板不可用",
    },
    skillPanel: {
      title: "技能",
      subtitle: "浏览并管理这段对话可用的技能。",
      locked: "当前 run 进行中，技能变更已锁定。现在的修改只会影响后续 run。",
      noWorkspaceSkills: "这个工作区下没有找到 `.ncoworker/skills`。",
      noFilteredSkills: "没有匹配当前筛选条件的技能。",
      active: "已启用",
      start: "启用",
      cancel: "撤销",
      cancelPending: "尚未发送，可撤销此技能的启用",
    },
    permission: {
      title: "需要权限",
      requestTool(toolName: string) {
        return `Agent 正在请求执行 ${toolName} 的权限。`
      },
      allow: "允许",
      deny: "拒绝",
      patchPreviewMissingTitle: "Patch 预览不可用",
      patchPreviewMissingBody: "当前只能看到持久化的文件摘要。批准前请仔细核对下面列出的文件。",
      patchFilesChanged(files: number, additions: number, deletions: number) {
        return `${files} 个文件变更，+${additions}/-${deletions}`
      },
    },
    message: {
      result: "结果",
      error: "错误",
      showMore: "展开",
      showLess: "收起",
      viewDetails: "查看详情",
      hideDetails: "收起详情",
      thinking: "正在思考",
      running: "进行中",
      waitingPermission: "等待授权",
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
      updatingSkills: "正在激活技能",
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
      skillsUpdated: "技能已激活",
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
      completedRead(detail: string) { return `读取了 ${detail}` },
      completedReadFallback: "读取了文件",
      completedWrote(detail: string) { return `写入了 ${detail}` },
      completedWroteFallback: "写入了文件",
      completedEdited(detail: string) { return `编辑了 ${detail}` },
      completedEditedFallback: "编辑了文件",
      completedRan(detail: string) { return `运行了 ${detail}` },
      completedRanFallback: "运行了命令",
      completedSearched(detail: string) { return `搜索了"${detail}"` },
      completedSearchedFallback: "搜索了网页",
      completedFetched(detail: string) { return `获取了 ${detail}` },
      completedFetchedFallback: "获取了网页",
      completedCodeSearch(detail: string) { return `搜索了 ${detail}` },
      completedCodeSearchFallback: "搜索了代码库",
      completedScanned(detail: string) { return `扫描了 ${detail}` },
      completedScannedFallback: "扫描了文件",
      completedFound(detail: string) { return `找到了 ${detail}` },
      completedFoundFallback: "找到了匹配文件",
      spawningSubagent: "正在派遣子代理",
      delegatingTask: "正在委派任务给子代理",
      completedAgent(detail: string) { return `派遣了 ${detail} 子代理` },
      completedAgentFallback: "派遣了子代理",
      completedGenericTool(name: string, detail: string) { return `${name}: ${detail}` },
      completedSkillActivation(name: string) { return `激活了 ${name}` },
      completedSkillList: "列出了技能",
      completedSkills: "更新了技能",
      completedActivity(label: string, duration: string | null) {
        return duration ? `已运行${label}（${duration}）` : `已运行${label}`
      },
      completedRunActivity(duration: string | null, toolNames: string[]) {
        const ranText = duration ? `已运行 ${duration}` : "已运行"
        if (toolNames.length === 0) return ranText
        return `${ranText}，调用了 ${toolNames.join("、")} 工具`
      },
      formatDuration(durationMs: number) {
        return `${(durationMs / 1000).toFixed(1)} 秒`
      },
      llmCall: "模型调用",
      cancelledSuffix: "（已取消）",
      failedSuffix: "失败",
      reasoning: "推理摘要",
    },
    settings: {
      title: "设置",
      close: "关闭",
      general: "通用",
      llm: "LLM 设置",
      storagePath: "存储于 .ncoworker/desktop-settings.json",
      language: "语言",
      appearance: "外观",
      theme: "主题",
      themeDark: "深色",
      themeLight: "浅色",
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
      reasoning: "推理",
      reasoningThinking: "启用思考",
      reasoningThinkingOn: "开",
      reasoningThinkingOff: "关",
      reasoningEffort: "推理强度",
      reasoningEffortDefault: "默认",
      reasoningEffortLow: "低",
      reasoningEffortMedium: "中",
      reasoningEffortHigh: "高",
      reasoningUnknownModelWarning: "models.dev 目录中未找到该模型。下方推理控件为手动覆盖。",
    },
    compatibility: {
      legacySessionTitle: "会话兼容性",
      legacySessionMessage:
        "这个会话是在支持推理之前创建的，无法在启用思考的情况下继续。请选择如何处理。",
      continueWithoutThinking: "不带思考继续",
      continueWithoutThinkingHint:
        "本会话的思考将保持关闭，直到你在设置中重新启用，或者新建一个会话。",
      startNewSession: "新建会话",
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
