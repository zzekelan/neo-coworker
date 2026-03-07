import { parseRunCommand } from "./cli/run-command"

export function buildCli() {
  return {
    parse(argv: string[]) {
      return parseRunCommand(argv)
    },
  }
}
