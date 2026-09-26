import { currentWikiDate } from "./wiki-date"
import { protectStarSymbols } from "./topic-markdown"
import { topicContentHash, topicCheckpointFilename, loadTopicCheckpoint, saveTopicCheckpoint } from "./topic-checkpoint"
import yaml from "js-yaml"
import { createDirectory, deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { streamChat } from "./llm-client"
import { resolveIngestReasoning } from "./reasoning-capabilities"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { findTopic, renderTopicCatalog, type TopicCatalog } from "./topic-catalog"
import { parseExcerptBlocks, type TopicExcerpt } from "./topic-excerpt"
import { buildTopicPageSkeleton, upsertExcerptBlock, removeExcerptBlocks } from "./topic-page"
import { readTopicPages, buildTopicIndex, topicPagePath } from "./topic-index"
import { parseFrontmatter } from "./frontmatter"
import { saveIngestCache } from "./ingest-cache"
import { excerptPrompt, sourceCardPrompt } from "./topic-prompts"

export const TOPIC_CHUNK_TARGET_MIN = 6_000
export const TOPIC_CHUNK_TARGET_MAX = 16_000
export const TOPIC_CHUNK_OVERLAP = 800
const TOPIC_RETRY_OVERLAP = 400
const TOPIC_MAX_SPLIT_DEPTH = 2
type TopicChunk = { main: string; headingPath?: string; overlapBefore?: string }

export interface TopicIngestContext {
  projectPath: string
  sourceIdentity: string
  sourceContent: string
  enrichedSourceContent: string
  sourceSummaryPath: string
  purpose: string
  folderContext?: string
  catalog: TopicCatalog
  llmConfig: LlmConfig
  activityId: string
  signal?: AbortSignal
  onFileWritten?: (path: string) => void
  runCommit: <T>(operation: () => Promise<T>) => Promise<T>
  sourceBudget: (contextSize: number | undefined, stableLength: number) => number
  splitChunks: (content: string, target: number, overlap: number) => TopicChunk[]
  maxTokens: (contextSize: number | undefined) => number
  language: string
  parseFiles: (text: string) => { blocks: Array<{ path: string; content: string }>; truncatedPaths: string[] }
  buildLog: (existing: string, source: string) => string
  injectImages: () => Promise<void>
}
const unsortedTopic = { id: "_unsorted", name: "未归类", aliases: [], related: [] }

export async function runTopicIngest(c: TopicIngestContext): Promise<string[]> {
  const startedAt = Date.now()
  let splitRetries = 0
  const activity = useActivityStore.getState()
  const warnings = [...c.catalog.warnings]
  const checkAbort = () => { if (c.signal?.aborted) throw new Error("Ingest cancelled") }
  const generate = async (system: string, user: string) => {
    checkAbort()
    let text = "", error: Error | undefined
    await streamChat(c.llmConfig, [{ role: "system", content: system }, { role: "user", content: user }], {
      onToken: token => { text += token }, onDone: () => {}, onError: err => { error = err },
    }, c.signal, { temperature: 0.1, reasoning: resolveIngestReasoning(c.llmConfig), max_tokens: c.maxTokens(c.llmConfig.maxContextSize) })
    checkAbort()
    if (error) throw error
    return text
  }
  try {
    const rendered = renderTopicCatalog(c.catalog)
    const budget = c.sourceBudget(c.llmConfig.maxContextSize, rendered.length + c.purpose.length)
    const target = Math.max(TOPIC_CHUNK_TARGET_MIN, Math.min(TOPIC_CHUNK_TARGET_MAX, budget))
    const chunks: TopicChunk[] = c.enrichedSourceContent.length <= target ? [{ main: c.enrichedSourceContent }] : c.splitChunks(c.enrichedSourceContent, target, TOPIC_CHUNK_OVERLAP)
    const system = excerptPrompt.replace("<language rule from languageRule()>", () => c.language).replace("<rendered catalog>", () => rendered).replace("<purpose.md, if non-empty>", () => c.purpose)
    const contentHash = topicContentHash(c.enrichedSourceContent)
    const checkpointPath = `${c.projectPath}/.llm-wiki/topic-ingest-checkpoints/${topicCheckpointFilename(c.sourceIdentity, contentHash)}`
    // Do not persist credentials. Include everything that changes extraction semantics.
    const fingerprint = topicContentHash(JSON.stringify({ version: 1, contentHash, source: c.sourceIdentity, target, overlap: TOPIC_CHUNK_OVERLAP,
      chunks, system, folder: c.folderContext, provider: c.llmConfig.provider, model: c.llmConfig.model,
      endpoint: c.llmConfig.customEndpoint, ollamaUrl: c.llmConfig.ollamaUrl,
      reasoning: resolveIngestReasoning(c.llmConfig), maxTokens: c.maxTokens(c.llmConfig.maxContextSize) }))
    const checkpoint = await loadTopicCheckpoint(checkpointPath, fingerprint, chunks.length)
    const resumedChunks = checkpoint.completed.length
    const extract = async (chunk: TopicChunk, label: string, depth: number): Promise<TopicExcerpt[]> => {
      activity.updateItem(c.activityId, { detail: `Extracting topic excerpts ${label}/${chunks.length}...` })
      const overlap = chunk.overlapBefore ? `\nPrevious context (context only; extract from the main chunk, avoid duplicate facts):\n${chunk.overlapBefore}\n` : ""
      const output = await generate(system, `Source: ${c.sourceIdentity}\nFolder context: ${c.folderContext ?? ""}\nSection/page context: ${chunk.headingPath ?? ""}\nChunk ${label}/${chunks.length}\n${overlap}\n--- Main chunk ---\n\n${chunk.main}`)
      const parsed = parseExcerptBlocks(output, c.catalog)
      warnings.push(...parsed.warnings)
      if (parsed.warnings.some(w => w.startsWith("Unclosed excerpt"))) {
        if (depth >= TOPIC_MAX_SPLIT_DEPTH) throw new Error(parsed.warnings.join("; "))
        const children = c.splitChunks(chunk.main, Math.floor(chunk.main.length / 2), TOPIC_RETRY_OVERLAP)
        if (children.length < 2 || children.some(child => child.main.length >= chunk.main.length)) throw new Error(`${parsed.warnings.join("; ")}; chunk cannot be split further`)
        splitRetries++
        warnings.push(`Split truncated chunk ${label} at depth ${depth + 1} into ${children.length} smaller chunks`)
        const result: TopicExcerpt[] = []
        for (let j = 0; j < children.length; j++) result.push(...await extract({ ...children[j], headingPath: children[j].headingPath || chunk.headingPath,
          overlapBefore: j === 0 ? chunk.overlapBefore : children[j].overlapBefore }, `${label}.${j + 1}`, depth + 1))
        return result
      }
      if (output.trim() && !parsed.excerpts.length && !/^---EXCERPT:/m.test(output)) throw new Error("Invalid excerpt response: expected EXCERPT blocks or empty output")
      return parsed.excerpts
    }
    const excerpts: TopicExcerpt[] = []
    for (let i = 0; i < chunks.length; i++) {
      checkAbort()
      const saved = checkpoint.completed[i]
      if (saved) { excerpts.push(...saved.excerpts); warnings.push(...saved.warnings); continue }
      const warningStart = warnings.length
      const extracted = await extract(chunks[i], String(i + 1), 0)
      checkpoint.completed.push({ excerpts: extracted, warnings: warnings.slice(warningStart) })
      await saveTopicCheckpoint(checkpointPath, checkpoint)
      excerpts.push(...extracted)
    }
    const groups = new Map<string, TopicExcerpt[]>()
    for (const excerpt of excerpts) groups.set(excerpt.topicId, [...(groups.get(excerpt.topicId) ?? []), excerpt])
    const topicList = [...groups].map(([id, list]) => `${id}\n${list.flatMap(e => e.body.split("\n")).slice(0, 2).join("\n")}`).join("\n\n")
    activity.updateItem(c.activityId, { detail: "Writing source card..." })
    const cardOutput = await generate(sourceCardPrompt.replace("<language rule>", () => c.language).replace("<sourceIdentity>", () => c.sourceIdentity).replace("<sourceSummaryPath>", () => c.sourceSummaryPath), `Current date: ${currentWikiDate()}\nSource: ${c.sourceIdentity}\n\n${c.enrichedSourceContent.slice(0, 6000)}\n\nExtracted topics:\n${topicList}`)
    const files = c.parseFiles(cardOutput)
    const cards = files.blocks.filter(b => b.path === c.sourceSummaryPath)
    if (cards.length !== 1 || files.truncatedPaths.includes(c.sourceSummaryPath)) {
      const diagnosticPath = ".llm-wiki/topic-ingest-source-card-failure.json"
      try {
        await createDirectory(`${c.projectPath}/.llm-wiki`)
        await writeFile(`${c.projectPath}/${diagnosticPath}`, JSON.stringify({
          source: c.sourceIdentity, expectedPath: c.sourceSummaryPath,
          receivedPaths: files.blocks.map(block => block.path), truncatedPaths: files.truncatedPaths,
          response: cardOutput,
        }, null, 2))
      } catch (error) { console.warn("[topic-ingest] could not save source-card diagnostic", error) }
      throw new Error(`Source card missing, duplicated or truncated (expected ${c.sourceSummaryPath}; received ${cards.length} matching blocks). Details: ${diagnosticPath}`)
    }
    const parsedCard = parseFrontmatter(cards[0].content)
    if (!parsedCard.frontmatter || !parsedCard.body.trim()) throw new Error("Source card has invalid frontmatter or empty body")
    const date = currentWikiDate()
    const fm = { ...parsedCard.frontmatter, type: "source", sources: [c.sourceIdentity], created: parsedCard.frontmatter.created || date, updated: date, tags: parsedCard.frontmatter.tags ?? [] }
    const links = [...groups.keys()].map(id => `- [[${id}|${findTopic(c.catalog, id)?.topic.name ?? "未归类"}]]`).join("\n")
    const card = `---\n${yaml.dump(fm)}---\n${protectStarSymbols(parsedCard.body.trim())}\n\n## 涉及主题\n${links}\n`
    return await c.runCommit(async () => {
      checkAbort()
      const pages = await readTopicPages(c.projectPath)
      const originals = new Map(pages)
      for (const [path, content] of pages) pages.set(path, removeExcerptBlocks(content, c.sourceIdentity, date))
      for (const [id, list] of groups) {
        const match = findTopic(c.catalog, id)
        const path = match ? topicPagePath(match.category.id, id) : "wiki/topics/_unsorted.md"
        const topic = match?.topic ?? unsortedTopic
        const category = match?.category ?? { id: "_unsorted", name: "未归类", topics: [topic] }
        const existing = pages.get(path) ?? buildTopicPageSkeleton(topic, category, c.catalog, date)
        const body = list.map(e => {
          const title = [c.sourceIdentity.split("/").pop(), e.location, e.device, id === "_unsorted" && e.suggest ? `建议主题：${e.suggest}` : undefined].filter(Boolean).join(" · ")
          return `### ${title}\n${protectStarSymbols(e.body)}`
        }).join("\n\n")
        // Use original page when this topic remains so its source block keeps its position.
        pages.set(path, upsertExcerptBlock(originals.get(path) ?? existing, c.sourceIdentity, body, date))
      }
      const writes = new Map([...pages].filter(([path, content]) => content !== originals.get(path)))
      writes.set(c.sourceSummaryPath, card)
      writes.set("wiki/index.md", buildTopicIndex(c.catalog, pages))
      const logPath = `${c.projectPath}/wiki/log.md`
      writes.set("wiki/log.md", c.buildLog(await fileExists(logPath) ? await readFile(logPath) : "", c.sourceIdentity))
      const writtenPaths: string[] = []
      // All parsing and page edits above finish before the first disk write.
      for (const [path, content] of writes) {
        checkAbort()
        await createDirectory(`${c.projectPath}/${path.slice(0, path.lastIndexOf("/"))}`)
        await writeFile(`${c.projectPath}/${path}`, content)
        writtenPaths.push(path)
        c.onFileWritten?.(path)
      }
      await c.injectImages()
      checkAbort()
      if (warnings.length) {
        await createDirectory(`${c.projectPath}/.llm-wiki`)
        const path = `${c.projectPath}/.llm-wiki/ingest-warnings.log`
        const previous = await fileExists(path) ? await readFile(path) : ""
        await writeFile(path, `${previous}\n${date} ${c.sourceIdentity}\n${warnings.join("\n")}\n`)
      }
      await saveIngestCache(c.projectPath, c.sourceIdentity, c.sourceContent, writtenPaths)
      const emb = useWikiStore.getState().embeddingConfig
      if (emb.enabled && emb.model) {
        const { embedPage } = await import("./embedding")
        for (const path of writtenPaths) {
          if (["wiki/index.md", "wiki/log.md"].includes(path)) continue
          try {
            const content = await readFile(`${c.projectPath}/${path}`)
            const id = path.split("/").pop()!.replace(/\.md$/, "")
            const title = parseFrontmatter(content).frontmatter?.title
            await embedPage(c.projectPath, id, typeof title === "string" ? title : id, content, emb)
          } catch (error) { console.warn("[topic-ingest] embedding failed", error) }
        }
      }
      await deleteFile(checkpointPath)
      try {
        await writeFile(`${c.projectPath}/.llm-wiki/topic-ingest-last-run.json`, JSON.stringify({ source: c.sourceIdentity, contentHash, target,
          chunkCount: chunks.length, resumedChunks, splitRetries, elapsedMs: Date.now() - startedAt, completedAt: new Date().toISOString(), warnings }, null, 2))
      } catch (error) { console.warn("[topic-ingest] could not save run metrics", error) }
      activity.updateItem(c.activityId, { status: "done", detail: `${writtenPaths.length} files written${warnings.length ? ` — ${warnings.join("; ")}` : ""}`, filesWritten: writtenPaths })
      return writtenPaths
    })
  } catch (error) {
    if (warnings.length) {
      try {
        const path = `${c.projectPath}/.llm-wiki/ingest-warnings.log`
        await createDirectory(`${c.projectPath}/.llm-wiki`)
        const previous = await fileExists(path) ? await readFile(path) : ""
        await writeFile(path, `${previous}\n${currentWikiDate()} ${c.sourceIdentity} (failed)\n${warnings.join("\n")}\n`)
      } catch { /* Preserve the original failure. */ }
    }
    activity.updateItem(c.activityId, { status: "error", detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
