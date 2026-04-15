declare module "bun:test" {
  export const afterEach: (callback: () => void | Promise<void>) => void
  export const describe: (label: string, callback: () => void | Promise<void>) => void
  export const test: (label: string, callback: () => void | Promise<void>) => void
  export const expect: any
}
