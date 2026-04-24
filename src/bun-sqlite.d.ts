declare module "bun:sqlite" {
  export type DatabaseOptions = {
    create?: boolean
    readonly?: boolean
    strict?: boolean
  }

  export type StatementRunResult = {
    changes: number
    lastInsertRowid: number | bigint
  }

  export type Statement<TParams extends unknown[] = unknown[]> = {
    get(...params: TParams): unknown
    all(...params: TParams): unknown[]
    run(...params: TParams): StatementRunResult
  }

  export class Database {
    readonly filename?: string
    readonly handle: number | bigint

    constructor(filename: string, options?: DatabaseOptions)

    query<TParams extends unknown[] = unknown[]>(sql: string): Statement<TParams>
    exec(sql: string): void
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult
    serialize(): Uint8Array
    close(throwOnError?: boolean): void
  }
}
