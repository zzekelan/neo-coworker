import {
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptSection,
} from "./prompt-composer"

export {
  composeFullPrompt,
  composeSystemPrompt,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type PromptSection,
}

export const DEFAULT_SYSTEM_PROMPT: string = getStaticPrompt()
