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
  const chunks = splitSourceIntoSemanticChunks(text, Math.max(6000, Math.min(16000, computeIngestSourceBudget(16000, renderTopicCatalog(parseTopicCatalog(fixture)).length))), 800)
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
  const chunks = splitSourceIntoSemanticChunks(text, Math.max(6000, Math.min(16000, computeIngestSourceBudget(16000, renderTopicCatalog(parseTopicCatalog(fixture)).length))), 800)
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

it('caps large-context chunks, resumes completed chunks after a card failure, and clears the checkpoint', async () => {
  const text = Array.from({ length: 1600 }, (_, i) => `## Section ${i}\nTR = ${i} ms. T2* signal.\n`).join('\n')
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, text)
  const { splitSourceIntoSemanticChunks } = await import('./ingest')
  const chunks = splitSourceIntoSemanticChunks(text, 16000, 800)
  responses = [...chunks.map(() => excerpt()), 'invalid card']
  await expect(ingest()).rejects.toThrow('Source card')
  expect(calls).toHaveLength(chunks.length + 1)
  expect(calls[1].messages[1].content).toContain(chunks[1].overlapBefore)
  const { readdir } = await import('node:fs/promises')
  const dir = `${tmp.path}/.llm-wiki/topic-ingest-checkpoints`
  expect(await readdir(dir)).toHaveLength(1)
  calls = []; responses = [card()]
  await ingest()
  expect(calls).toHaveLength(1)
  expect(await readdir(dir)).toHaveLength(0)
})

it('retries a truncated chunk with smaller chunks and protects written star symbols', async () => {
  const text = '## Relaxation\n' + 'T2* signal and TR = 4000 ms.\n'.repeat(200)
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, text)
  const { splitSourceIntoSemanticChunks } = await import('./ingest')
  const children = splitSourceIntoSemanticChunks(text, Math.floor(text.length / 2), 400)
  responses = [excerpt().replace('---END EXCERPT---', ''), ...children.map(() => excerpt().replace('1000 s/mm²', 'T2*')), card()]
  await ingest()
  expect(calls).toHaveLength(children.length + 2)
  expect(await readFileRaw(`${tmp.path}/wiki/topics/sequences/dwi.md`)).toContain('`T2*`')
  expect(await readFileRaw(`${tmp.path}/.llm-wiki/ingest-warnings.log`)).toContain('Split truncated chunk')
})

it('stops after two split levels and preserves existing pages', async () => {
  responses = [excerpt(), card()]
  await ingest()
  const topicPath = `${tmp.path}/wiki/topics/sequences/dwi.md`
  const before = await readFileRaw(topicPath)
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, Array.from({ length: 180 }, (_, i) => `## Sequence ${i}\nTR = 4000 ms. ${'Parameter details. '.repeat(3)}\n`).join('\n'))
  responses = Array(20).fill(excerpt().replace('---END EXCERPT---', ''))
  calls = []
  await expect(ingest()).rejects.toThrow('Unclosed excerpt')
  expect(calls).toHaveLength(3)
  expect(await readFileRaw(topicPath)).toBe(before)
  expect(await readFileRaw(`${tmp.path}/.llm-wiki/ingest-warnings.log`)).toContain('depth 2')
})

it.each(['content', 'model', 'catalog', 'corrupt'])('invalidates incompatible checkpoints: %s', async change => {
  responses = [excerpt(), 'bad card']
  await expect(ingest()).rejects.toThrow('Source card')
  if (change === 'content') await writeFileRaw(`${tmp.path}/raw/sources/${source}`, 'New source data')
  if (change === 'model') useWikiStore.getState().setLlmConfig({ ...useWikiStore.getState().llmConfig, model: 'different-model' })
  if (change === 'catalog') await writeFileRaw(`${tmp.path}/topics.yaml`, fixture.replace('扩散物理与 DWI', '扩散知识'))
  if (change === 'corrupt') {
    const { readdir } = await import('node:fs/promises')
    const dir = `${tmp.path}/.llm-wiki/topic-ingest-checkpoints`
    for (const name of await readdir(dir)) await writeFileRaw(`${dir}/${name}`, '{bad json')
  }
  calls = []; responses = [excerpt(), card()]
  await ingest()
  expect(calls).toHaveLength(2)
})

it('resumes after an extraction failure without duplicating the first chunk', async () => {
  const text = Array.from({ length: 900 }, (_, i) => `## Page ${i}\nTR = ${i} ms.\n`).join('\n')
  await writeFileRaw(`${tmp.path}/raw/sources/${source}`, text)
  const { splitSourceIntoSemanticChunks } = await import('./ingest')
  const chunks = splitSourceIntoSemanticChunks(text, 16000, 800)
  responses = [excerpt().replace('1000', '1234'), 'invalid response']
  await expect(ingest()).rejects.toThrow('Invalid excerpt response')
  calls = []; responses = [...chunks.slice(1).map(() => excerpt()), card()]
  await ingest()
  expect(calls).toHaveLength(chunks.length)
  const page = await readFileRaw(`${tmp.path}/wiki/topics/sequences/dwi.md`)
  expect(page.match(/1234/g)).toHaveLength(1)
})

it('bounds checkpoint filenames for long Unicode names without identity collisions', async () => {
  const { topicCheckpointFilename } = await import('./topic-checkpoint')
  const name = '磁'.repeat(80)
  const pdf = topicCheckpointFilename(`${name}.pdf`, '0123456789abcdef')
  expect(Buffer.byteLength(pdf)).toBeLessThan(255)
  expect(pdf).not.toBe(topicCheckpointFilename(`${name}.md`, '0123456789abcdef'))
})
