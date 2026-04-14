import { describe, expect, test } from "bun:test"

import {
  assessCommandRisk,
  RiskLevel,
} from "../../src/permission"

describe("permission risk analyzer", () => {
  test("classifies rm -rf / as critical", () => {
    expect(assessCommandRisk("rm -rf /").level).toBe(RiskLevel.CRITICAL)
  })

  test("classifies chmod 777 as dangerous", () => {
    expect(assessCommandRisk("chmod 777 script.sh").level).toBe(RiskLevel.DANGEROUS)
  })

  test("classifies SSH private key access as dangerous", () => {
    expect(assessCommandRisk("cat ~/.ssh/id_rsa").level).toBe(RiskLevel.DANGEROUS)
  })

  test("classifies env file access as moderate", () => {
    expect(assessCommandRisk("cat .env").level).toBe(RiskLevel.MODERATE)
  })

  test("classifies git push --force as dangerous", () => {
    expect(assessCommandRisk("git push --force origin master").level).toBe(RiskLevel.DANGEROUS)
  })

  test("classifies ls -la as safe", () => {
    expect(assessCommandRisk("ls -la")).toEqual({
      level: RiskLevel.SAFE,
      patterns: [],
      explanation: "No known dangerous patterns detected.",
    })
  })

  test("defaults unknown benign commands to safe", () => {
    expect(assessCommandRisk("echo hello").level).toBe(RiskLevel.SAFE)
  })

  test("uses the highest risk level for compound commands", () => {
    expect(assessCommandRisk("ls && rm -rf /").level).toBe(RiskLevel.CRITICAL)
  })
})
