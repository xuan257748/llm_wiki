import yaml from "js-yaml"
import { fileExists, readFile } from "@/commands/fs"

export interface Topic { id: string; name: string; aliases: string[]; related: string[] }
export interface TopicCategory { id: string; name: string; topics: Topic[] }
export interface TopicCatalog { version: 1; categories: TopicCategory[]; warnings: string[] }
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("topics.yaml: expected object")
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("topics.yaml: expected non-empty string")
  return value
}
function id(value: unknown): string {
  const result = name(value)
  if (!idPattern.test(result)) throw new Error(`topics.yaml: invalid id ${result}`)
  return result
}
function strings(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("topics.yaml: expected string array")
  return value.map(name)
}
export function parseTopicCatalog(text: string): TopicCatalog {
  const root = record(yaml.load(text, { schema: yaml.JSON_SCHEMA }))
  if (root.version !== 1 || !Array.isArray(root.categories)) throw new Error("topics.yaml: expected version 1 and categories array")
  const categoryIds = new Set<string>(), topicIds = new Set<string>()
  const categories = root.categories.map(value => {
    const c = record(value), categoryId = id(c.id)
    if (categoryIds.has(categoryId)) throw new Error(`topics.yaml: duplicate category ${categoryId}`)
    categoryIds.add(categoryId)
    if (!Array.isArray(c.topics)) throw new Error("topics.yaml: expected topics array")
    return { id: categoryId, name: name(c.name), topics: c.topics.map(value => {
      const t = record(value), topicId = id(t.id)
      if (topicIds.has(topicId)) throw new Error(`topics.yaml: duplicate topic ${topicId}`)
      topicIds.add(topicId)
      return { id: topicId, name: name(t.name), aliases: strings(t.aliases), related: strings(t.related) }
    }) }
  })
  const warnings = categories.flatMap(c => c.topics.flatMap(t => t.related.filter(r => !topicIds.has(r)).map(r => `Unknown related topic: ${t.id} -> ${r}`)))
  return { version: 1, categories, warnings }
}
export async function loadTopicCatalog(projectPath: string): Promise<TopicCatalog | null> {
  const path = `${projectPath}/topics.yaml`
  if (!await fileExists(path)) return null
  return parseTopicCatalog(await readFile(path))
}
export function renderTopicCatalog(catalog: TopicCatalog): string {
  return catalog.categories.map(c => `## ${c.name}\n${c.topics.map(t => `${t.id} | ${t.name} | 别名: ${t.aliases.join(", ")}`).join("\n")}`).join("\n\n")
}
export function findTopic(catalog: TopicCatalog, topicId: string) {
  for (const category of catalog.categories) {
    const topic = category.topics.find(t => t.id === topicId)
    if (topic) return { topic, category }
  }
  return undefined
}
