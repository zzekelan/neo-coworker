export type PrimaryAgent = {
  name: string
  description: string
}

/**
 * Returns the next primary agent in the cycle, wrapping at the end.
 * Returns first agent if currentAgent is not in the list.
 * Returns currentAgent unchanged if the list is empty.
 */
export function getNextPrimaryAgent(
  currentAgent: string,
  primaryAgents: PrimaryAgent[],
): string {
  if (primaryAgents.length === 0) {
    return currentAgent
  }

  const currentIndex = primaryAgents.findIndex((agent) => agent.name === currentAgent)
  if (currentIndex === -1) {
    return primaryAgents[0]!.name
  }

  const nextIndex = (currentIndex + 1) % primaryAgents.length
  return primaryAgents[nextIndex]!.name
}
