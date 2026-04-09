import type {
  CreateSubSessionInput,
  RunTrigger,
  StoredSession,
} from "./ports/repository"
import {
  buildDefaultSessionTitle,
  buildSessionPreviewFromUserPrompt,
  buildSessionTitleFromUserPrompt,
  normalizeSessionActiveSkills,
} from "../domain"

export type BuildCreateSubSessionInput = {
  parentSession: StoredSession
  prompt: string
  trigger: RunTrigger
  skills?: readonly string[] | null
}

export function buildCreateSubSessionInput(
  input: BuildCreateSubSessionInput,
): CreateSubSessionInput {
  const activeSkills = normalizeSessionActiveSkills(
    input.skills ?? input.parentSession.activeSkills,
  )

  return {
    parentSessionId: input.parentSession.id,
    directory: input.parentSession.directory,
    workspaceRoot: input.parentSession.workspaceRoot,
    activeSkills,
    title: buildSessionTitleFromUserPrompt(input.prompt) || buildDefaultSessionTitle(),
    latestUserMessagePreview: buildSessionPreviewFromUserPrompt(input.prompt) || null,
  }
}
