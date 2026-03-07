export function createEventQueue<T>() {
  const items: T[] = []
  let done = false

  return {
    push(item: T) {
      items.push(item)
    },
    close() {
      done = true
    },
    async *stream() {
      while (!done || items.length > 0) {
        const next = items.shift()
        if (next !== undefined) {
          yield next
          continue
        }

        await Bun.sleep(0)
      }
    },
  }
}
