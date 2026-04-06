declare module "bun:test" {
  export const describe: typeof import("node:test").describe
  export const test: typeof import("node:test").test
  export const expect: any
}
