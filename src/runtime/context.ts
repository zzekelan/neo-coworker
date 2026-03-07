type MessagePart = {
  type: string
  text?: string
}

type Message = {
  role: string
  parts: MessagePart[]
}

type Tool = {
  name: string
  description: string
}

export function buildModelInput(input: {
  systemPrompt: string
  activeSkillInstructions: string[]
  tools: Tool[]
  messages: Message[]
}) {
  const toolList = input.tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n")
  const skillText = input.activeSkillInstructions.join("\n\n")

  return {
    system: [input.systemPrompt, skillText, "Available tools:", toolList]
      .filter(Boolean)
      .join("\n\n"),
    messages: input.messages,
  }
}
