import { findTopic, type TopicCatalog } from "./topic-catalog"
export interface TopicExcerpt { topicId: string; location?: string; device?: string; suggest?: string; body: string }
export function parseExcerptBlocks(text: string, catalog: TopicCatalog): { excerpts: TopicExcerpt[]; warnings: string[] } {
  const excerpts: TopicExcerpt[] = [], warnings: string[] = []
  const starts = [...text.matchAll(/^---EXCERPT:\s*([^\r\n]+?)---[ \t]*\r?$/gm)]
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const segment = text.slice(start.index! + start[0].length, starts[i + 1]?.index ?? text.length)
    const end = /^---END EXCERPT---[ \t]*\r?$/m.exec(segment)
    if (!end) { warnings.push(`Unclosed excerpt: ${start[1]}`); continue }
    const lines = segment.slice(0, end.index).trim().split(/\r?\n/)
    let topicId = start[1].trim()
    const metadata: Partial<TopicExcerpt> = {}
    while (lines.length) {
      const match = /^(LOC|DEVICE|SUGGEST):\s*(.*)$/.exec(lines[0])
      if (!match) break
      const key = { LOC: "location", DEVICE: "device", SUGGEST: "suggest" }[match[1]] as "location" | "device" | "suggest"
      if (match[2].trim()) metadata[key] = match[2].trim()
      lines.shift()
    }
    const body = lines.join("\n").trim()
    if (!body) continue
    if (topicId !== "_unsorted" && !findTopic(catalog, topicId)) {
      warnings.push(`Unknown topic ${topicId}; filed under _unsorted`)
      metadata.suggest ??= topicId
      topicId = "_unsorted"
    }
    excerpts.push({ topicId, ...metadata, body })
  }
  return { excerpts, warnings }
}
