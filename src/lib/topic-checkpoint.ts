import { sourceSummarySlugFromIdentity } from "./source-identity"
import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { TopicExcerpt } from "./topic-excerpt"

/** Stable content identity, not a security primitive. Full chunk shape is also fingerprinted. */
export function topicContentHash(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n)
  return hash.toString(16).padStart(16, "0")
}
export interface TopicCheckpoint {
  fingerprint: string
  completed: Array<{ excerpts: TopicExcerpt[]; warnings: string[] }>
}
export async function loadTopicCheckpoint(path: string, fingerprint: string, count: number): Promise<TopicCheckpoint> {
  try {
    if (await fileExists(path)) {
      const value = JSON.parse(await readFile(path)) as TopicCheckpoint
      if (value.fingerprint === fingerprint && Array.isArray(value.completed) && value.completed.length <= count && value.completed.every(chunk =>
        chunk && Array.isArray(chunk.warnings) && chunk.warnings.every(w => typeof w === "string") && Array.isArray(chunk.excerpts) && chunk.excerpts.every(e =>
          e && typeof e.topicId === "string" && typeof e.body === "string" && [e.location, e.device, e.suggest].every(v => v === undefined || typeof v === "string")))) return value
    }
  } catch { /* Corrupt or incompatible checkpoints are safely regenerated. */ }
  return { fingerprint, completed: [] }
}
export async function saveTopicCheckpoint(path: string, checkpoint: TopicCheckpoint): Promise<void> {
  await createDirectory(path.slice(0, path.lastIndexOf("/")))
  await writeFileAtomic(path, JSON.stringify(checkpoint))
}

export function topicCheckpointFilename(source: string, contentHash: string): string {
  // At most 160 UTF-8 bytes, leaving room for both hashes under NAME_MAX.
  const slug = Array.from(sourceSummarySlugFromIdentity(source)).slice(0, 40).join("")
  return `${slug}-${topicContentHash(source)}-${contentHash}.json`
}
