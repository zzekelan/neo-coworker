import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  getConfigDir,
  getStoragePath,
  getServerStoragePath,
  getAgentsDir,
  _resetWarningState,
} from "../../src/bootstrap/paths"

describe("bootstrap paths", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "paths-test-"))
    _resetWarningState()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns .ncoworker path when neither dir exists", () => {
    const p = getStoragePath(tmpDir)
    expect(p).toContain(".ncoworker")
    expect(p).toContain("agent.sqlite")
  })

  it("returns .ncoworker path when .ncoworker already exists", async () => {
    await mkdir(join(tmpDir, ".ncoworker"), { recursive: true })
    const p = getStoragePath(tmpDir)
    expect(p).toContain(".ncoworker")
  })

  it("falls back to .agents when legacy exists and .ncoworker does not", async () => {
    await mkdir(join(tmpDir, ".agents"), { recursive: true })
    const p = getStoragePath(tmpDir)
    expect(p).toContain(".agents")
  })

  it("getAgentsDir always returns .ncoworker/agents", () => {
    const p = getAgentsDir(tmpDir)
    expect(p).toContain(".ncoworker")
    expect(p).toContain("agents")
  })

  it("getConfigDir returns .ncoworker when neither dir exists", () => {
    const p = getConfigDir(tmpDir)
    expect(p).toContain(".ncoworker")
  })

  it("getConfigDir falls back to .agents when legacy exists and .ncoworker does not", async () => {
    await mkdir(join(tmpDir, ".agents"), { recursive: true })
    const p = getConfigDir(tmpDir)
    expect(p).toContain(".agents")
  })

  it("getServerStoragePath returns .ncoworker/server.sqlite when neither dir exists", () => {
    const p = getServerStoragePath(tmpDir)
    expect(p).toContain(".ncoworker")
    expect(p).toContain("server.sqlite")
  })

  it("getServerStoragePath falls back to .agents when legacy exists and .ncoworker does not", async () => {
    await mkdir(join(tmpDir, ".agents"), { recursive: true })
    const p = getServerStoragePath(tmpDir)
    expect(p).toContain(".agents")
    expect(p).toContain("server.sqlite")
  })

  it("does not warn twice for the same legacy path", async () => {
    await mkdir(join(tmpDir, ".agents"), { recursive: true })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    try {
      getStoragePath(tmpDir)
      getStoragePath(tmpDir)
      expect(warnings.length).toBe(1)
    } finally {
      console.warn = originalWarn
    }
  })
})
