// A tab opened before deployment can still reference removed, hashed route chunks.
// Recover once using the new HTML; persistent failures must never reload in a loop.
const RETRY_KEY = 'farm_route_chunk_retry'

export function recoverRouteChunk(
  error: unknown,
  destination: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  replace: (path: string) => void,
) {
  const message = error instanceof Error ? error.message : String(error)
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk [\w-]+ failed/i.test(message))
    return false
  if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\') || Array.from(destination).some(char => char.charCodeAt(0) < 32))
    return false
  try {
    if (storage.getItem(RETRY_KEY))
      return false
    storage.setItem(RETRY_KEY, '1')
  }
  catch {
    // Without durable per-tab state a reload could repeat indefinitely.
    return false
  }
  replace(destination)
  return true
}

export function clearRouteChunkRetry(storage: Pick<Storage, 'removeItem'>) {
  try {
    storage.removeItem(RETRY_KEY)
  }
  catch {}
}
