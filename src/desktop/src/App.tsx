import React, { useEffect, useState } from "react"
import { useAgent } from "./hooks/useAgent"
import { useDesktopSettings } from "./useDesktopSettings"
import { DesktopTextProvider } from "./i18n"
import { Sidebar } from "./components/Sidebar"
import { ChatArea } from "./components/ChatArea"
import { KeyboardShortcutProvider } from "./providers/KeyboardShortcutProvider"
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
  } = useAgent()
  const desktopSettings = useDesktopSettings()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [clearedTranscriptState, setClearedTranscriptState] = useState<{
    sessionId: string
    hiddenCount: number
  } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = desktopSettings.settings.theme
  }, [desktopSettings.settings.theme])

  useEffect(() => {
    setClearedTranscriptState(null)
  }, [activeSessionId])

  const visibleTranscript =
    activeSessionId && clearedTranscriptState?.sessionId === activeSessionId
      ? transcript.slice(Math.min(clearedTranscriptState.hiddenCount, transcript.length))
      : transcript

  const handleToggleTheme = () => {
    const nextTheme = desktopSettings.settings.theme === "dark" ? "light" : "dark"
    desktopSettings.updateSettings({ theme: nextTheme })
  }

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
    <KeyboardShortcutProvider
      onNewSession={() => void createSession()}
      onToggleTheme={handleToggleTheme}
      onClearTranscript={handleClearTranscriptDisplay}
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
          />
        </div>
        <CommandPalette />
      </div>
    </DesktopTextProvider>
    </KeyboardShortcutProvider>
  )
}
