import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLayeredSkillRuntime,
  createLayeredSkillStore,
  createSkillWriteService,
  SkillNotFoundError,
} from "../../src/skill"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("layered skill loading", () => {
  test("loads materialized built-in skills when no higher-precedence layer overrides them", async () => {
    const workspaceRoot = await createTempDirectory("layered-skill-workspace-")
    const xdgConfigHome = await createTempDirectory("layered-skill-config-")
    const xdgDataHome = await createTempDirectory("layered-skill-data-")

    await withEnv({ XDG_CONFIG_HOME: xdgConfigHome, XDG_DATA_HOME: xdgDataHome }, async () => {
      const runtime = createLayeredSkillRuntime()
      const skill = await runtime.loadSkill({ workspaceRoot, name: "deep-research" })

      expect(skill).toMatchObject({
        name: "deep-research",
        description: "Placeholder built-in Deep Research skill",
        path: "builtin:research/deep-research/SKILL.md",
        entryPath: "SKILL.md",
        source: "builtin",
        files: [],
      })
      expect(skill.baseDir).toBe(
        `file://${join(xdgDataHome, "neo-coworker", "builtin-skills", "research", "deep-research")}/`,
      )
      expect(skill.instructions).toContain("name: deep-research")
    })
  })

  test("applies workspace > global > built-in precedence and reports hidden duplicates", async () => {
    const workspaceRoot = await createTempDirectory("layered-skill-workspace-")
    const xdgConfigHome = await createTempDirectory("layered-skill-config-")
    const xdgDataHome = await createTempDirectory("layered-skill-data-")

    await writeWorkspaceSkill(workspaceRoot, ["research", "deep-research"], {
      description: "Workspace Deep Research override",
      body: "Use the workspace research process.",
    })
    await writeGlobalSkill(xdgConfigHome, ["research", "deep-research"], {
      description: "Global Deep Research override",
      body: "Use the global research process.",
    })

    await withEnv({ XDG_CONFIG_HOME: xdgConfigHome, XDG_DATA_HOME: xdgDataHome }, async () => {
      const runtime = createLayeredSkillRuntime()
      const catalog = await runtime.listCatalog(workspaceRoot)
      const deepResearchEntries = catalog.filter((skill) => skill.name === "deep-research")

      expect(deepResearchEntries).toEqual([
        {
          name: "deep-research",
          description: "Workspace Deep Research override",
          path: ".ncoworker/skills/research/deep-research/SKILL.md",
          source: "workspace",
          overrides: [
            {
              source: "global",
              path: "global:research/deep-research/SKILL.md",
            },
            {
              source: "builtin",
              path: "builtin:research/deep-research/SKILL.md",
            },
          ],
        },
      ])

      const loaded = await runtime.loadSkill({ workspaceRoot, name: "deep-research" })
      expect(loaded).toMatchObject({
        name: "deep-research",
        description: "Workspace Deep Research override",
        path: ".ncoworker/skills/research/deep-research/SKILL.md",
        source: "workspace",
        entryPath: "SKILL.md",
        files: [],
      })
      expect(loaded.instructions).toContain("Use the workspace research process.")
    })
  })

  test("loads global skills read-only and keeps CRUD operations workspace-only", async () => {
    const workspaceRoot = await createTempDirectory("layered-skill-workspace-")
    const xdgConfigHome = await createTempDirectory("layered-skill-config-")
    const xdgDataHome = await createTempDirectory("layered-skill-data-")

    await writeGlobalSkill(xdgConfigHome, ["reviewer"], {
      description: "Global reviewer",
      body: "Use global review rules.",
    })

    await withEnv({ XDG_CONFIG_HOME: xdgConfigHome, XDG_DATA_HOME: xdgDataHome }, async () => {
      const store = createLayeredSkillStore()
      const runtime = createLayeredSkillRuntime({ store })
      const service = createSkillWriteService({ store })
      const globalSkillPath = join(
        xdgConfigHome,
        "neo-coworker",
        "skills",
        "reviewer",
        "SKILL.md",
      )
      const originalGlobalContent = await readFile(globalSkillPath, "utf8")

      await expect(runtime.listCatalog(workspaceRoot)).resolves.toContainEqual({
        name: "reviewer",
        description: "Global reviewer",
        path: "global:reviewer/SKILL.md",
        source: "global",
      })
      await expect(runtime.loadSkill({ workspaceRoot, name: "reviewer" })).resolves.toMatchObject({
        name: "reviewer",
        source: "global",
        path: "global:reviewer/SKILL.md",
      })

      await expect(
        service.patchSkill({
          workspaceRoot,
          name: "reviewer",
          patch: "Use workspace review rules.",
        }),
      ).rejects.toBeInstanceOf(SkillNotFoundError)
      await expect(
        service.deleteSkill({
          workspaceRoot,
          name: "reviewer",
        }),
      ).rejects.toBeInstanceOf(SkillNotFoundError)
      await expect(readFile(globalSkillPath, "utf8")).resolves.toBe(originalGlobalContent)

      await service.createSkill({
        workspaceRoot,
        name: "reviewer",
        content: "Use workspace review rules.",
        frontmatter: { description: "Workspace reviewer" },
      })

      await expect(readFile(globalSkillPath, "utf8")).resolves.toBe(originalGlobalContent)
      await expect(
        readFile(join(workspaceRoot, ".ncoworker", "skills", "reviewer", "SKILL.md"), "utf8"),
      ).resolves.toContain("Use workspace review rules.")
      await expect(runtime.loadSkill({ workspaceRoot, name: "reviewer" })).resolves.toMatchObject({
        name: "reviewer",
        description: "Workspace reviewer",
        path: ".ncoworker/skills/reviewer/SKILL.md",
        source: "workspace",
      })
    })
  })
})

async function createTempDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

async function writeWorkspaceSkill(
  workspaceRoot: string,
  pathSegments: string[],
  input: { description: string; body: string },
) {
  const packageDirectory = join(workspaceRoot, ".ncoworker", "skills", ...pathSegments)
  await writeSkillFile(packageDirectory, pathSegments.at(-1)!, input)
}

async function writeGlobalSkill(
  xdgConfigHome: string,
  pathSegments: string[],
  input: { description: string; body: string },
) {
  const packageDirectory = join(xdgConfigHome, "neo-coworker", "skills", ...pathSegments)
  await writeSkillFile(packageDirectory, pathSegments.at(-1)!, input)
}

async function writeSkillFile(
  packageDirectory: string,
  name: string,
  input: { description: string; body: string },
) {
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(
    join(packageDirectory, "SKILL.md"),
    [
      `name: ${name}`,
      `description: ${input.description}`,
      "",
      input.body,
      "",
    ].join("\n"),
  )
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
