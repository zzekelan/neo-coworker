import React, { useState } from "react"
import { useAgent } from "./hooks/useAgent"
import { Sidebar } from "./components/Sidebar"
import { ChatArea } from "./components/ChatArea"

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
    isManagingWorkspace,
    skills,
    session,
    transcript,
    permissionRequests,
    isOnline,
    sendMessage,
    cancelRun,
    replyPermission,
    setSessionActiveSkills,
    setRunActiveSkills,
    errorMessage,
    skillWarningMessage,
  } = useAgent()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  return (
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
        isManagingWorkspace={isManagingWorkspace}
        isOnline={isOnline}
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
      />
      <div className="relative flex min-w-0 flex-1 flex-col border-l border-ink/5 bg-white/40">
        <ChatArea
          sessionSummary={sessions.find((candidate) => candidate.id === activeSessionId) || null}
          session={session}
          skills={skills}
          transcript={transcript}
          permissionRequests={permissionRequests}
          onSendMessage={sendMessage}
          onCancelRun={cancelRun}
          onReplyPermission={replyPermission}
          onSetSessionActiveSkills={setSessionActiveSkills}
          onSetRunActiveSkills={setRunActiveSkills}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          errorMessage={errorMessage}
          skillWarningMessage={skillWarningMessage}
        />
      </div>
    </div>
  )
}
