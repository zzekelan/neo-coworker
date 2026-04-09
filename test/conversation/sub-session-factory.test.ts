import { describe, expect, test } from "bun:test"

import {
  buildCreateSubSessionInput,
} from "../../src/session/application/sub-session-input"
import type { StoredSession as RepositoryStoredSession } from "../../src/session/application/ports/repository"

describe("sub-session factory", () => {
  test("prefers explicit skills over parent active skills", () => {
    const parentSession: RepositoryStoredSession = {
      id: "session_parent",
      directory: "/workspace/packages/app",
      workspaceRoot: "/workspace",
      createdAt: 10,
      title: "Parent",
      updatedAt: 20,
      latestUserMessagePreview: "existing preview",
      activeSkills: ["explore", "review"],
      parentSessionId: undefined,
    }

    const created = buildCreateSubSessionInput({
      parentSession,
      prompt: "Investigate failing eval case for tool isolation",
      trigger: "prompt",
      skills: [" oracle ", "oracle", ""],
    })

    expect(created).toMatchObject({
      parentSessionId: parentSession.id,
      directory: "/workspace/packages/app",
      workspaceRoot: "/workspace",
      activeSkills: ["oracle"],
      title: "Investigate failing eval case for tool isolation",
      latestUserMessagePreview: "Investigate failing eval case for tool isolation",
    })
    expect(created.activeSkills).not.toBe(parentSession.activeSkills)
  })

  test("falls back to parent activeSkills and preserves empty arrays", () => {
    const parentSession: RepositoryStoredSession = {
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 10,
      title: "Parent",
      updatedAt: 20,
      latestUserMessagePreview: null,
      activeSkills: [],
      parentSessionId: undefined,
    }

    const created = buildCreateSubSessionInput({
      parentSession,
      prompt: "Search for architecture violations",
      trigger: "prompt",
      skills: null,
    })

    expect(created.activeSkills).toEqual([])
    expect(created.activeSkills).not.toBe(parentSession.activeSkills)
    expect(created.parentSessionId).toBe(parentSession.id)
  })

  test("falls back to normalized parent activeSkills when explicit skills are omitted", () => {
    const parentSession: RepositoryStoredSession = {
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 10,
      title: "Parent",
      updatedAt: 20,
      latestUserMessagePreview: null,
      activeSkills: [" explore ", "review", "review"],
      parentSessionId: undefined,
    }

    const created = buildCreateSubSessionInput({
      parentSession,
      prompt: "Search for architecture violations",
      trigger: "prompt",
    })

    expect(created.activeSkills).toEqual(["explore", "review"])
    expect(created.activeSkills).not.toBe(parentSession.activeSkills)
  })
})
