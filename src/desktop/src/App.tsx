import React, { useEffect, useState } from "react"
import { useAgent } from "./hooks/useAgent"
import { useDesktopSettings } from "./useDesktopSettings"
import { DesktopTextProvider } from "./i18n"
import { Sidebar } from "./components/Sidebar"
import { ChatArea } from "./components/ChatArea"
import { KeyboardShortcutProvider } from "./providers/KeyboardShortcutProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import { CommandPalette } from "./components/CommandPalette"

export default function App() {
  const {
    workspaces,
    activeWorkspaceRoot,
    setActiveWorkspace,
    sessions,
    activeSessionId,
    setActiveSessionId,
    createSession,
    createWorkspace,
    deleteSession,
    isManagingWorkspace,
    skills,
    session,
    transcript,
    permissionRequests,
    isOnline,
    hasAuthoritativeBusyState,
    sendMessage,
    cancelRun,
    replyPermission,
    setSessionActiveSkills,
    errorMessage,
    skillWarningMessage,
    contextUsage,
    refreshAppState,
    cycleAgent,
    currentAgent,
    primaryAgents,
    setAgent,
  } = useAgent()
  const desktopSettings = useDesktopSettings()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [clearedTranscriptState, setClearedTranscriptState] = useState<{
    sessionId: string
    hiddenCount: number
  } | null>(null)

  useEffect(() => {
    setClearedTranscriptState(null)
  }, [activeSessionId])

  const visibleTranscript =
    activeSessionId && clearedTranscriptState?.sessionId === activeSessionId
      ? transcript.slice(Math.min(clearedTranscriptState.hiddenCount, transcript.length))
      : transcript

  const handleClearTranscriptDisplay = () => {
    if (!activeSessionId) {
      return
    }

    setClearedTranscriptState({
      sessionId: activeSessionId,
      hiddenCount: transcript.length,
    })
  }

  return (
    <ThemeProvider
      theme={desktopSettings.settings.theme}
      onThemeChange={(next) => { void desktopSettings.persistTheme(next) }}
    >
    <KeyboardShortcutProvider
      onNewSession={() => void createSession()}
      onClearTranscript={handleClearTranscriptDisplay}
      onCycleAgent={cycleAgent}
    >
      <DesktopTextProvider language={desktopSettings.appliedSettings.language}>
        <div className="flex h-screen w-full overflow-hidden bg-paper font-sans text-ink selection:bg-accent/20 selection:text-ink">
          <Sidebar
          workspaces={workspaces}
          activeWorkspaceRoot={activeWorkspaceRoot}
          setActiveWorkspace={(workspaceRoot) => {
            void setActiveWorkspace(workspaceRoot)
          }}
          sessions={sessions}
          activeSessionId={activeSessionId}
          setActiveSessionId={(sessionId) => {
            void setActiveSessionId(sessionId)
          }}
          createSession={() => {
            void createSession()
          }}
          createWorkspace={createWorkspace}
          deleteSession={(sessionId) => {
            void deleteSession(sessionId)
          }}
          settings={desktopSettings.settings}
          serverMode={desktopSettings.serverMode}
          settingsErrorMessage={desktopSettings.errorMessage}
          settingsSuccessMessage={desktopSettings.successMessage}
          isApplyingSettings={desktopSettings.isApplying}
          onUpdateSettings={(patch) => {
            void desktopSettings.updateSettings(patch)
          }}
          onApplyGeneralSettings={() => {
            void desktopSettings.applyGeneralSettings()
          }}
          onApplyLlmSettings={() => {
            void desktopSettings.applyLlmSettings().then((restarted) => {
              if (restarted) {
                void refreshAppState()
              }
            })
          }}
          isManagingWorkspace={isManagingWorkspace}
          isOnline={isOnline}
          hasAuthoritativeBusyState={hasAuthoritativeBusyState}
          isOpen={isSidebarOpen}
          onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        />
        <div className="relative flex min-w-0 flex-1 flex-col border-l border-border bg-paper">
          <ChatArea
            sessionSummary={sessions.find((candidate) => candidate.id === activeSessionId) || null}
            hasSessions={sessions.length > 0}
            session={session}
            skills={skills}
            transcript={visibleTranscript}
            permissionRequests={permissionRequests}
            contextUsage={contextUsage}
            onSendMessage={sendMessage}
            onCancelRun={cancelRun}
            onReplyPermission={replyPermission}
            onSetSessionActiveSkills={setSessionActiveSkills}
            onCreateSession={() => {
              void createSession()
            }}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
            errorMessage={errorMessage}
            skillWarningMessage={skillWarningMessage}
            modelName={desktopSettings.settings.model || undefined}
            currentAgent={currentAgent}
            primaryAgents={primaryAgents}
            onSetAgent={setAgent}
          />
        </div>
        <CommandPalette />
      </div>
    </DesktopTextProvider>
    </KeyboardShortcutProvider>
    </ThemeProvider>
  )
}
