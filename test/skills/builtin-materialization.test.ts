import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  getBuiltinSkillsDirectory,
  materializeBuiltinSkills,
} from "../../src/skill"

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false
    }

    throw error
  }
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

describe("built-in skill materialization", () => {
  test("copies source-owned built-in packages directly into the XDG data cache", async () => {
    const xdgDataHome = await mkdtemp(join(tmpdir(), "builtin-skill-xdg-"))
    const workspaceRoot = await mkdtemp(join(tmpdir(), "builtin-skill-workspace-"))

    await withEnv({ XDG_DATA_HOME: xdgDataHome }, async () => {
      const result = await materializeBuiltinSkills()
      const builtinRoot = join(xdgDataHome, "neo-coworker", "builtin-skills")
      const deepResearchSkill = join(builtinRoot, "research", "deep-research", "SKILL.md")
      const manifestPath = join(builtinRoot, ".manifest.json")

      expect(result).toMatchObject({
        root: builtinRoot,
        changed: true,
        packages: [
          {
            category: "research",
            name: "deep-research",
            entryPath: "research/deep-research/SKILL.md",
          },
          {
            category: "research",
            name: "finding-synthesis",
            entryPath: "research/finding-synthesis/SKILL.md",
          },
          {
            category: "research",
            name: "source-note",
            entryPath: "research/source-note/SKILL.md",
          },
        ],
      })
      const deepResearchContent = await readFile(deepResearchSkill, "utf8")
      expect(deepResearchContent).toStartWith("---\n")
      expect(deepResearchContent).toContain("\n---\n\n")
      expect(deepResearchContent).toContain("name: deep-research")
      expect(deepResearchContent).toContain(
        "description: Plan and record file-based Deep Research artifacts",
      )
      expect(deepResearchContent).toContain("version: 1")

      const rootEntries = await readdir(builtinRoot)
      expect(rootEntries.sort()).toEqual([".manifest.json", "research"])
      await expect(exists(join(builtinRoot, "current"))).resolves.toBe(false)
      await expect(exists(join(builtinRoot, "v1"))).resolves.toBe(false)
      await expect(exists(join(builtinRoot, "1.0.0"))).resolves.toBe(false)
      await expect(exists(join(workspaceRoot, ".ncoworker", "skills"))).resolves.toBe(false)

      const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        generatedBy: "neo-coworker-builtin-skill-materializer",
        packages: [
          {
            category: "research",
            name: "deep-research",
            entryPath: "research/deep-research/SKILL.md",
            files: [
              {
                path: "research/deep-research/references/artifact-schema.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
              {
                path: "research/deep-research/references/finding-quality.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
              {
                path: "research/deep-research/references/source-note-schema.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
              {
                path: "research/deep-research/SKILL.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
            ],
          },
          {
            category: "research",
            name: "finding-synthesis",
            entryPath: "research/finding-synthesis/SKILL.md",
            files: [
              {
                path: "research/finding-synthesis/references/finding-quality.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
              {
                path: "research/finding-synthesis/SKILL.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
            ],
          },
          {
            category: "research",
            name: "source-note",
            entryPath: "research/source-note/SKILL.md",
            files: [
              {
                path: "research/source-note/references/source-note-schema.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
              {
                path: "research/source-note/SKILL.md",
                bytes: expect.any(Number),
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
            ],
          },
        ],
      })
      expect(manifest).not.toHaveProperty("materializedAt")
      expect(manifest.packages[0]).not.toHaveProperty("version")

      const secondResult = await materializeBuiltinSkills()
      const secondManifest = JSON.parse(await readFile(manifestPath, "utf8"))
      expect(secondResult.changed).toBe(false)
      expect(secondManifest).toEqual(manifest)
    })
  })

  test("falls back to ~/.local/share/neo-coworker/builtin-skills when XDG_DATA_HOME is unset", async () => {
    await withEnv({ XDG_DATA_HOME: undefined }, async () => {
      expect(getBuiltinSkillsDirectory()).toBe(
        join(homedir(), ".local", "share", "neo-coworker", "builtin-skills"),
      )
    })
  })
})
