import yaml from "js-yaml"
import { parseFrontmatter } from "./frontmatter"
import { findTopic, type Topic, type TopicCategory, type TopicCatalog } from "./topic-catalog"
const today = () => new Date().toISOString().slice(0, 10)
const escapeSource = (source: string) => source.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;")
const blockPattern = () => /^<!-- excerpt:begin source="([^"\r\n]*)" -->\r?\n[\s\S]*?^<!-- excerpt:end -->[ \t]*(?:\r?\n|$)/gm
export function countExcerptBlocks(content: string): number { return [...content.matchAll(blockPattern())].length }

export function buildTopicPageSkeleton(topic: Topic, category: TopicCategory, catalog: TopicCatalog, date: string): string {
  const fm = yaml.dump({ type: "topic", title: topic.name, category: category.id, aliases: topic.aliases, sources: [], created: date, updated: date })
  const sections = ["核心要点", "原理", "关键参数及影响", "厂家实现与叫法", "伪影与对策", "临床应用"].map(h => `## ${h}\n（待整理）`).join("\n\n")
  const related = topic.related.flatMap(id => { const t = findTopic(catalog, id); return t ? [`- [[${id}|${t.topic.name}]]`] : [] }).join("\n")
  return `---\n${fm}---\n# ${topic.name}\n\n${sections}\n\n## 资料摘录\n\n## 网络补充\n\n## 相关主题\n${related}\n`
}

// Update only these two YAML keys; preserve comments, formatting, unknown fields and body bytes.
function metadata(content: string, source: string, remove: boolean, date: string): string {
  const parsed = parseFrontmatter(content)
  if (!parsed.frontmatter || !content.startsWith(parsed.rawBlock)) throw new Error("Topic page has invalid or missing frontmatter")
  const old = parsed.frontmatter.sources
  const sources = Array.isArray(old) ? old : []
  const next = remove ? sources.filter(s => s !== source) : [...new Set([...sources, source])]
  let raw = parsed.rawBlock
  for (const [key, value] of [["sources", JSON.stringify(next)], ["updated", date]]) {
    const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? []
    const start = lines.findIndex(line => new RegExp(`^(?:${key}|"${key}"|'${key}')[ \t]*:`).test(line))
    if (start < 0) {
      raw = raw.replace(/\r?\n---(?=\s*$)/, () => `\n${key}: ${value}\n---`)
      continue
    }
    let end = start + 1
    // A field extends through flow-list closers and unindented block-list
    // items/comments, until the next root mapping key or YAML closing fence.
    while (end < lines.length && !/^(?:---[ \t]*(?:\r?\n|$)|[^ \t#\-\[\]{}\n][^\r\n]*?:[ \t\r\n])/.test(lines[end])) end++
    const comments = lines.slice(start + 1, end).filter(line => /^[ \t]*(?:#|\r?$)/.test(line))
    lines.splice(start, end - start, `${key}: ${value}\n`, ...comments)
    raw = lines.join("")
  }
  if (!parseFrontmatter(raw + content.slice(parsed.rawBlock.length)).frontmatter) throw new Error("Could not safely update topic frontmatter")
  return raw + content.slice(parsed.rawBlock.length)
}

// Ignore managed excerpt bodies and fenced code while finding real level-two sections.
function headings(content: string): Array<{ title: string; start: number; end: number }> {
  const result: Array<{ title: string; start: number; end: number }> = []
  let offset = 0, excerpt = false, fence = ""
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const clean = line.trimEnd()
    if (clean.startsWith('<!-- excerpt:begin source="')) excerpt = true
    else if (clean === "<!-- excerpt:end -->") excerpt = false
    else if (!excerpt) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(clean)
      if (f) {
        if (!fence) fence = f[1]
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = ""
      } else if (!fence) {
        const h = /^##[ \t]+(.+?)[ \t]*$/.exec(clean)
        if (h) result.push({ title: h[1], start: offset, end: offset + line.length })
      }
    }
    offset += line.length
  }
  return result
}
export function upsertExcerptBlock(content: string, sourceIdentity: string, blockBody: string, date = today()): string {
  if (/^<!-- excerpt:(?:begin|end)/m.test(blockBody)) throw new Error("Reserved excerpt boundary in body")
  const source = escapeSource(sourceIdentity)
  const block = `<!-- excerpt:begin source="${source}" -->\n${blockBody.trim()}\n<!-- excerpt:end -->\n`
  let replaced = false
  let next = content.replace(blockPattern(), (match, identity: string) => {
    if (identity !== source) return match
    if (replaced) return ""
    replaced = true
    return block
  })
  let hs = headings(next)
  let section = hs.find(h => h.title === "资料摘录")
  if (!section) {
    const at = next.search(blockPattern()) >= 0
      ? next.search(blockPattern())
      : hs.find(h => h.title === "网络补充")?.start ?? next.length
    next = next.slice(0, at) + (at && !next.slice(0, at).endsWith("\n") ? "\n" : "") + "## 资料摘录\n\n" + next.slice(at)
    hs = headings(next)
    section = hs.find(h => h.title === "资料摘录")!
  }
  if (!replaced) {
    const end = hs.find(h => h.start > section!.start)?.start ?? next.length
    next = next.slice(0, end) + (next.slice(0, end).endsWith("\n") ? "" : "\n") + block + "\n" + next.slice(end)
  }
  return metadata(next, sourceIdentity, false, date)
}
export function removeExcerptBlocks(content: string, sourceIdentity: string, date = today()): string {
  const source = escapeSource(sourceIdentity)
  const next = content.replace(blockPattern(), (match, identity: string) => identity === source ? "" : match)
  const sources = parseFrontmatter(content).frontmatter?.sources
  if (next === content && (!Array.isArray(sources) || !sources.includes(sourceIdentity))) return content
  return metadata(next, sourceIdentity, true, date)
}
