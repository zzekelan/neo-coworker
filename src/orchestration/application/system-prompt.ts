import {
  composeAgentAwarePrompt,
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptAgentProfile,
  type PromptSection,
} from "./prompt-composer"

export {
  composeAgentAwarePrompt,
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptAgentProfile,
  type PromptSection,
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
