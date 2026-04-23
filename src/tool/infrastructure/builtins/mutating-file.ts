import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

export type AtomicUtf8FileWrite = (filePath: string, content: string) => Promise<void>

type AtomicWriteOptions = {
  chmodFile?: (filePath: string, mode: number) => Promise<unknown>
  renameFile?: (from: string, to: string) => Promise<unknown>
  removeFile?: (filePath: string) => Promise<unknown>
  statFile?: (filePath: string) => Promise<{ mode: number }>
  writeTempFile?: (filePath: string, content: string) => Promise<unknown>
}

const fileMutationLocks = new Map<string, Promise<void>>()

export async function withSerializedFileMutation<T>(
  filePath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const normalizedFilePath = resolve(filePath)
  const previousMutation = fileMutationLocks.get(normalizedFilePath) ?? Promise.resolve()

  let releaseCurrentMutation!: () => void
  const currentMutation = new Promise<void>((resolveCurrentMutation) => {
    releaseCurrentMutation = resolveCurrentMutation
  })
  const queuedMutation = previousMutation.catch(() => undefined).then(() => currentMutation)

  fileMutationLocks.set(normalizedFilePath, queuedMutation)

  await previousMutation.catch(() => undefined)

  try {
    return await mutation()
  } finally {
    releaseCurrentMutation()

    if (fileMutationLocks.get(normalizedFilePath) === queuedMutation) {
      fileMutationLocks.delete(normalizedFilePath)
    }
  }
}

export async function writeUtf8FileAtomically(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(filePath)
  const temporaryPath = join(directory, `.${basename(filePath)}.tmp.${randomUUID()}`)
  const chmodFile = options.chmodFile ?? chmod
  const renameFile = options.renameFile ?? rename
  const removeFile = options.removeFile ?? ((path: string) => rm(path, { force: true }))
  const statFile = options.statFile ?? stat
  const writeTempFile = options.writeTempFile ?? ((path: string, value: string) => writeFile(path, value, "utf8"))

  await mkdir(directory, { recursive: true })

  const existingMode = await statFile(filePath)
    .then((fileStat) => fileStat.mode)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined
      }

      throw error
    })

  try {
    await writeTempFile(temporaryPath, content)

    if (existingMode !== undefined) {
      await chmodFile(temporaryPath, existingMode)
    }

    await renameFile(temporaryPath, filePath)
  } catch (error) {
    await removeFile(temporaryPath).catch(() => undefined)
    throw error
  }
}
