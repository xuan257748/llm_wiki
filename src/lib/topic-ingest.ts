import yaml from "js-yaml"
import { createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
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
  splitChunks: (content: string, target: number, overlap: number) => Array<{ main: string }>
  maxTokens: (contextSize: number | undefined) => number
  language: string
  parseFiles: (text: string) => { blocks: Array<{ path: string; content: string }>; truncatedPaths: string[] }
  buildLog: (existing: string, source: string) => string
  injectImages: () => Promise<void>
}
const unsortedTopic = { id: "_unsorted", name: "未归类", aliases: [], related: [] }

export async function runTopicIngest(c: TopicIngestContext): Promise<string[]> {
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
    const chunks = c.enrichedSourceContent.length <= budget ? [{ main: c.enrichedSourceContent }] : c.splitChunks(c.enrichedSourceContent, budget, 0)
    const excerpts: TopicExcerpt[] = []
    const system = excerptPrompt.replace("<language rule from languageRule()>", () => c.language).replace("<rendered catalog>", () => rendered).replace("<purpose.md, if non-empty>", () => c.purpose)
    for (let i = 0; i < chunks.length; i++) {
      activity.updateItem(c.activityId, { detail: `Extracting topic excerpts ${i + 1}/${chunks.length}...` })
      const output = await generate(system, `Source: ${c.sourceIdentity}\nFolder context: ${c.folderContext ?? ""}\nChunk ${i + 1}/${chunks.length}\n\n---\n\n${chunks[i].main}`)
      const parsed = parseExcerptBlocks(output, c.catalog)
      warnings.push(...parsed.warnings)
      // Never replace complete old excerpts with a partially generated source.
      if (parsed.warnings.some(w => w.startsWith("Unclosed excerpt"))) throw new Error(parsed.warnings.join("; "))
      if (output.trim() && !parsed.excerpts.length && !/^---EXCERPT:/m.test(output)) throw new Error("Invalid excerpt response: expected EXCERPT blocks or empty output")
      excerpts.push(...parsed.excerpts)
    }
    const groups = new Map<string, TopicExcerpt[]>()
    for (const excerpt of excerpts) groups.set(excerpt.topicId, [...(groups.get(excerpt.topicId) ?? []), excerpt])
    const topicList = [...groups].map(([id, list]) => `${id}\n${list.flatMap(e => e.body.split("\n")).slice(0, 2).join("\n")}`).join("\n\n")
    activity.updateItem(c.activityId, { detail: "Writing source card..." })
    const cardOutput = await generate(sourceCardPrompt.replace("<language rule>", () => c.language).replace("<sourceIdentity>", () => c.sourceIdentity).replace("<sourceSummaryPath>", () => c.sourceSummaryPath), `${c.enrichedSourceContent.slice(0, 6000)}\n\nExtracted topics:\n${topicList}`)
    const files = c.parseFiles(cardOutput)
    const cards = files.blocks.filter(b => b.path === c.sourceSummaryPath)
    if (cards.length !== 1 || files.truncatedPaths.includes(c.sourceSummaryPath)) throw new Error("Source card missing, duplicated or truncated")
    const parsedCard = parseFrontmatter(cards[0].content)
    if (!parsedCard.frontmatter || !parsedCard.body.trim()) throw new Error("Source card has invalid frontmatter or empty body")
    const date = new Date().toISOString().slice(0, 10)
    const fm = { ...parsedCard.frontmatter, type: "source", sources: [c.sourceIdentity], created: parsedCard.frontmatter.created || date, updated: date, tags: parsedCard.frontmatter.tags ?? [] }
    const links = [...groups.keys()].map(id => `- [[${id}|${findTopic(c.catalog, id)?.topic.name ?? "未归类"}]]`).join("\n")
    const card = `---\n${yaml.dump(fm)}---\n${parsedCard.body.trim()}\n\n## 涉及主题\n${links}\n`
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
          return `### ${title}\n${e.body}`
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
      activity.updateItem(c.activityId, { status: "done", detail: `${writtenPaths.length} files written${warnings.length ? ` — ${warnings.join("; ")}` : ""}`, filesWritten: writtenPaths })
      return writtenPaths
    })
  } catch (error) {
    activity.updateItem(c.activityId, { status: "error", detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
