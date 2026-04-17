import {
  buildStaticPromptAssembly,
  composeAgentAwarePrompt,
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptAgentProfile,
  type PromptSection,
  type ToolGuidanceEntry,
} from "./prompt-composer"

export {
  buildStaticPromptAssembly,
  composeAgentAwarePrompt,
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptAgentProfile,
  type PromptSection,
  type ToolGuidanceEntry,
}

export const DEFAULT_SYSTEM_PROMPT: string = getStaticPrompt()

export function buildAgentAwarePrompt(profile?: PromptAgentProfile) {
  return composeAgentAwarePrompt(
    {
      environment: {
        workingDirectory: "",
        platform: "unknown",
        date: "",
      },
    },
    profile,
  )
}
