import React, { useState } from "react"
import { useAgent } from "./hooks/useAgent"
import { Sidebar } from "./components/Sidebar"
import { ChatArea } from "./components/ChatArea"

export default function App() {
  const {
    projects,
    activeWorkspace,
    setActiveWorkspace,
    threads,
    activeThreadId,
    setActiveThreadId,
    createThread,
    createWorkspace,
    isManagingWorkspace,
    session,
    transcript,
    permissionRequests,
    isOnline,
    sendMessage,
    cancelRun,
    replyPermission,
    errorMessage,
  } = useAgent()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  return (
    <div className="flex h-screen w-full overflow-hidden bg-paper font-sans text-ink selection:bg-accent/20 selection:text-ink">
      <Sidebar
        projects={projects}
        activeWorkspace={activeWorkspace}
        setActiveWorkspace={(workspaceRoot) => {
          void setActiveWorkspace(workspaceRoot)
        }}
        threads={threads}
        activeThreadId={activeThreadId}
        setActiveThreadId={(threadId) => {
          void setActiveThreadId(threadId)
        }}
        createThread={() => {
          void createThread()
        }}
        createWorkspace={createWorkspace}
        isManagingWorkspace={isManagingWorkspace}
        isOnline={isOnline}
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
      />
      <div className="relative flex min-w-0 flex-1 flex-col border-l border-ink/5 bg-white/40">
        <ChatArea
          thread={threads.find((thread) => thread.id === activeThreadId) || null}
          session={session}
          transcript={transcript}
          permissionRequests={permissionRequests}
          onSendMessage={sendMessage}
          onCancelRun={cancelRun}
          onReplyPermission={replyPermission}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          errorMessage={errorMessage}
        />
      </div>
    </div>
  )
}
