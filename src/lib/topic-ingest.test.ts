import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createTempProject, realFs, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => realFs)
let responses: string[] = []
let calls: Array<{ messages: Array<{ content: string }>; options: unknown }> = []
vi.mock("./llm-client", () => ({ streamChat: vi.fn(async (_cfg, messages, cb, _signal, options) => {
  calls.push({ messages, options })
  cb.onToken(responses.shift() ?? "")
  cb.onDone()
}) }))
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { checkIngestCache } from "./ingest-cache"
const fixture = readFileSync("tests/fixtures/topic-ingest/topics.yaml", "utf8")
let tmp: Awaited<ReturnType<typeof createTempProject>>
const source = "training/neuro.md"
const summary = `wiki/sources/${sourceSummarySlugFromIdentity(source)}.md`
const card = () => `---FILE: ${summary}---\n---\ntype: source\ntitle: Neuro\ncreated: 2026-09-26\nupdated: 2026-09-26\ntags: []\nsources: ["${source}"]\n---\n# Neuro\n厂商培训资料，适用于 Aera / E11。\n---END FILE---`
const excerpt = (id = "dwi") => `---EXCERPT: ${id}---\nLOC: p.12\nDEVICE: Aera / E11\n- b = 1000 s/mm²\n---END EXCERPT---`
const ingest = () => autoIngest(tmp.path, `${tmp.path}/raw/sources/${source}`, useWikiStore.getState().llmConfig)
beforeEach(async () => {
  tmp = await createTempProject("topic-ingest")
  responses = []; calls = []
  useActivityStore.setState({ items: [] }); useReviewStore.setState({ items: [] })
  useWikiStore.getState().setLlmConfig({ provider: "openai", apiKey: "test-key", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 })
  useWikiStore.getState().setOutputLanguage("Chinese")
  await writeFileRaw(`${tmp.path}/topics.yaml`, fixture)
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, "## Page 12\nDWI: b = 1000 s/mm². Aera / E11.")
})
afterEach(async () => { vi.restoreAllMocks(); await tmp.cleanup() })
describe("topic ingest", () => {
  it("imports topics and source card only, then replaces old excerpts across topics", async () => {
    responses = [excerpt(), card() + "\n---FILE: wiki/concepts/bad.md---\nBAD\n---END FILE---"]
    const paths = await ingest()
    expect(paths).toContain("wiki/topics/sequences/dwi.md")
    expect(calls).toHaveLength(2)
    expect(calls[0].messages[0].content).toContain("PRESERVE EXACT VALUES")
    expect(calls[0].options).toMatchObject({ temperature: 0.1 })
    expect(await readFileRaw(`${tmp.path}/${summary}`)).toContain("[[dwi|扩散物理与 DWI]]")
    expect(await fileExists(`${tmp.path}/wiki/concepts`)).toBe(false)
    expect(await fileExists(`${tmp.path}/wiki/entities`)).toBe(false)
    expect(await fileExists(`${tmp.path}/wiki/overview.md`)).toBe(false)
    expect(useReviewStore.getState().items).toEqual([])
    const topicPath = `${tmp.path}/wiki/topics/sequences/dwi.md`
    await writeFileRaw(topicPath, (await readFileRaw(topicPath)).replace("## 原理\n（待整理）", "## 原理\n手写内容"))
    await writeFileRaw(`${tmp.path}/raw/sources/${source}`, "changed EPI source")
    responses = [excerpt("epi"), card()]
    await ingest()
    expect(await readFileRaw(topicPath)).not.toContain("excerpt:begin")
    expect(await readFileRaw(topicPath)).toContain("手写内容")
    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toContain("[[dwi|扩散物理与 DWI]] · 0 份资料")
    expect(await readFileRaw(`${tmp.path}/wiki/topics/sequences/epi.md`)).toContain("1000 s/mm²")
  })
  it("rejects invalid catalogs visibly without using the old flow", async () => {
    await writeFileRaw(`${tmp.path}/topics.yaml`, "version: 2")
    await expect(ingest()).rejects.toThrow()
    expect(calls).toHaveLength(0)
    expect(useActivityStore.getState().items[0].status).toBe("error")
  })
  it("fails before writing when the source card is truncated", async () => {
    responses = [excerpt(), card().replace("---END FILE---", "")]
    await expect(ingest()).rejects.toThrow()
    expect(await readFileRaw(`${tmp.path}/.llm-wiki/topic-ingest-source-card-failure.json`)).toContain("truncated")
    expect(await fileExists(`${tmp.path}/wiki/topics`)).toBe(false)
    expect(await checkIngestCache(tmp.path, source, await readFileRaw(`${tmp.path}/raw/sources/${source}`))).toBeNull()
  })
  it("accepts documents without MRI knowledge and creates only the card and index", async () => {
    responses = ["", card()]
    await ingest()
    expect(await fileExists(`${tmp.path}/wiki/topics`)).toBe(false)
    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toContain("扩散物理与 DWI · 暂无")
  })
})

it("deletes only source excerpts and preserves topic pages and handwritten links", async () => {
  responses = [excerpt(), card()]
  await ingest()
  const path = `${tmp.path}/wiki/topics/sequences/dwi.md`
  const manual = `手写 [[${sourceSummarySlugFromIdentity(source)}|资料]]`
  await writeFileRaw(path, (await readFileRaw(path)).replace("## 原理\n（待整理）", `## 原理\n${manual}`))
  const { deleteSourceFiles } = await import("./source-lifecycle")
  await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/${source}`])
  const remaining = await readFileRaw(path)
  expect(remaining).toContain(manual)
  expect(remaining).not.toContain("excerpt:begin")
  expect(remaining).toContain("sources: []")
  expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toContain("[[dwi|扩散物理与 DWI]] · 0 份资料")
})

it("does not cache an incomplete excerpt response or a failed write", async () => {
  responses = [excerpt().replace("---END EXCERPT---", "")]
  await expect(ingest()).rejects.toThrow("Unclosed excerpt")
  expect(await fileExists(`${tmp.path}/wiki/topics`)).toBe(false)
  responses = [excerpt(), card()]
  vi.spyOn(realFs, "writeFile").mockRejectedValueOnce(new Error("disk full"))
  await expect(ingest()).rejects.toThrow("disk full")
  expect(await checkIngestCache(tmp.path, source, await readFileRaw(`${tmp.path}/raw/sources/${source}`))).toBeNull()
  expect(useActivityStore.getState().items[0].status).toBe("error")
})

it("extracts original long chunks without analysis and keeps per-chunk order", async () => {
  useWikiStore.getState().setLlmConfig({ ...useWikiStore.getState().llmConfig, maxContextSize: 16000 })
  const text = Array.from({ length: 350 }, (_, i) => `## Page ${i + 1}\n- DWI parameter b = ${i} s/mm²; TR = 4000 ms.\n`).join("\n")
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, text)
  const { computeIngestSourceBudget, splitSourceIntoSemanticChunks } = await import("./ingest")
  const { parseTopicCatalog, renderTopicCatalog } = await import("./topic-catalog")
  const chunks = splitSourceIntoSemanticChunks(text, computeIngestSourceBudget(16000, renderTopicCatalog(parseTopicCatalog(fixture)).length), 0)
  expect(chunks.length).toBeGreaterThan(1)
  responses = [...chunks.map((_, i) => excerpt().replace("1000", String(i))), card()]
  await ingest()
  expect(calls).toHaveLength(chunks.length + 1)
  for (let i = 0; i < chunks.length; i++) expect(calls[i].messages[1].content).toContain(chunks[i].main)
  const content = await readFileRaw(`${tmp.path}/wiki/topics/sequences/dwi.md`)
  expect(content.match(/excerpt:begin/g)).toHaveLength(1)
  expect(content.indexOf("b = 0")).toBeLessThan(content.indexOf("b = 1"))
})
it.each(['---EXCERPT: dwi', `${excerpt()}\n---EXCERPT: te`])('rejects an incomplete excerpt header without deleting existing knowledge', async output => {
  responses = [excerpt(), card()]
  await ingest()
  const before = await readFileRaw(`${tmp.path}/wiki/topics/sequences/dwi.md`)
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, 'changed source')
  responses = [output, card()]
  await expect(ingest()).rejects.toThrow()
  expect(await readFileRaw(`${tmp.path}/wiki/topics/sequences/dwi.md`)).toBe(before)
})
it('carries page context into continuation chunks', async () => {
  useWikiStore.getState().setLlmConfig({ ...useWikiStore.getState().llmConfig, maxContextSize: 16000 })
  const text = '## Page 12\n' + '- TR = 4000 ms; b = 1000 s/mm².\n'.repeat(1000)
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, text)
  const { computeIngestSourceBudget, splitSourceIntoSemanticChunks } = await import('./ingest')
  const { parseTopicCatalog, renderTopicCatalog } = await import('./topic-catalog')
  const chunks = splitSourceIntoSemanticChunks(text, computeIngestSourceBudget(16000, renderTopicCatalog(parseTopicCatalog(fixture)).length), 0)
  responses = [...chunks.map(() => excerpt()), card()]
  await ingest()
  expect(calls[1].messages[1].content).toContain('Page 12')
})
it('instructs the source-card model with the exact FILE delimiters and destination', async () => {
  responses = [excerpt(), card()]
  await ingest()
  const prompt = calls[1].messages[0].content
  expect(prompt).toContain(`---FILE: ${summary}---`)
  expect(prompt).toContain('---END FILE---')
  expect(prompt).not.toContain('<sourceSummaryPath>')
  expect(prompt).not.toContain('<sourceIdentity>')
})
