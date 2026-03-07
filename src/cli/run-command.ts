export type RunCommand = {
  command: "run"
  prompt: string
}

export function parseRunCommand(argv: string[]): RunCommand {
  const [command, ...rest] = argv

  if (command !== "run") {
    throw new Error("Only `run` is supported in MVP")
  }

  return {
    command,
    prompt: rest.join(" "),
  }
}
