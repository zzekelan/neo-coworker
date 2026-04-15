import { describe, expect, test } from "bun:test"

import {
  RiskAssessmentService,
  type RiskAssessmentObserverEvent,
} from "../../src/permission/application/risk-assessment-service"
import { RiskLevel } from "../../src/permission/domain/risk-analyzer"

describe("risk assessment service", () => {
  test("assesses shell reasons with the command risk analyzer", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "shell",
      reason: "shell rm -rf /",
    })

    expect(assessment).toMatchObject({
      level: RiskLevel.CRITICAL,
      patterns: ["recursive root delete"],
    })
  })

  test("keeps benign shell reasons safe", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "shell",
      reason: "shell ls src",
    })

    expect(assessment).toEqual({
      level: RiskLevel.SAFE,
      patterns: [],
      explanation: "No known dangerous patterns detected.",
    })
  })

  test("flags write reasons targeting environment files", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "write",
      reason: "write .env.production",
    })

    expect(assessment).toMatchObject({
      level: RiskLevel.DANGEROUS,
      patterns: ["environment file path"],
    })
  })

  test("flags edit reasons targeting ssh paths", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "edit",
      reason: "edit ~/.ssh/id_ed25519",
    })

    expect(assessment).toMatchObject({
      level: RiskLevel.DANGEROUS,
      patterns: ["ssh directory path"],
    })
  })

  test("flags write reasons targeting /etc paths", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "write",
      reason: "write /etc/hosts",
    })

    expect(assessment).toMatchObject({
      level: RiskLevel.DANGEROUS,
      patterns: ["system /etc path"],
    })
  })

  test("defaults unknown tools to safe", () => {
    const service = new RiskAssessmentService()

    const assessment = service.assessFromPermissionRequest({
      toolName: "read",
      reason: "shell rm -rf /",
    })

    expect(assessment.level).toBe(RiskLevel.SAFE)
  })

  test("emits risk.assessed telemetry with a reason snippet", () => {
    const events: RiskAssessmentObserverEvent[] = []
    const service = new RiskAssessmentService(undefined, {
      recordPermissionEvent(event) {
        events.push(event)
      },
    })
    const reason = `write ${"nested/".repeat(30)}file.txt`

    service.assessFromPermissionRequest(
      {
        toolName: "write",
        reason,
      },
      {
        sessionId: "session_1",
        runId: "run_1",
      },
    )

    expect(events).toEqual([
      {
        type: "risk.assessed",
        sessionId: "session_1",
        runId: "run_1",
        toolName: "write",
        riskLevel: RiskLevel.SAFE,
        patterns: [],
        reasonSnippet: reason.slice(0, 120),
      },
    ])
  })

  test("overrides allow mode to ask for risky requests and emits override telemetry", () => {
    const events: RiskAssessmentObserverEvent[] = []
    const service = new RiskAssessmentService(undefined, {
      recordPermissionEvent(event) {
        events.push(event)
      },
    })

    const mode = service.resolveModeForRequest({
      request: {
        toolName: "write",
        reason: "write .env",
      },
      originalMode: "allow",
      sessionId: "session_1",
      runId: "run_1",
    })

    expect(mode).toBe("ask")
    expect(events).toEqual([
      {
        type: "risk.assessed",
        sessionId: "session_1",
        runId: "run_1",
        toolName: "write",
        riskLevel: RiskLevel.DANGEROUS,
        patterns: ["environment file path"],
        reasonSnippet: "write .env",
      },
      {
        type: "permission.dangerous_override",
        sessionId: "session_1",
        runId: "run_1",
        toolName: "write",
        originalMode: "allow",
        riskLevel: RiskLevel.DANGEROUS,
      },
    ])
  })
})
