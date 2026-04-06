import {
  composeSystemPrompt,
  defaultSections,
  type PromptSection,
} from "./prompt-composer"

export { composeSystemPrompt, defaultSections, type PromptSection }

export const DEFAULT_SYSTEM_PROMPT: string = composeSystemPrompt(defaultSections)
