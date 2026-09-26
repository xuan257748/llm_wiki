import { fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import type { TopicCatalog } from "./topic-catalog"
import { parseFrontmatter } from "./frontmatter"
import { countExcerptBlocks } from "./topic-page"
export const topicPagePath = (categoryId: string, topicId: string) => `wiki/topics/${categoryId}/${topicId}.md`
export async function readTopicPages(projectPath: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (!await fileExists(`${projectPath}/wiki/topics`)) return result
  const visit = async (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) await visit(node.children ?? [])
      else if (node.path.endsWith(".md")) result.set(node.path.slice(projectPath.length + 1), await readFile(node.path))
    }
  }
  await visit(await listDirectory(`${projectPath}/wiki/topics`))
  return result
}
export function buildTopicIndex(catalog: TopicCatalog, pages: Map<string, string>): string {
  const sections = catalog.categories.map(category => `## ${category.name}\n${category.topics.map(topic => {
    const page = pages.get(topicPagePath(category.id, topic.id))
    if (page === undefined) return `- ${topic.name} · 暂无`
    const sources = parseFrontmatter(page).frontmatter?.sources
    return `- [[${topic.id}|${topic.name}]] · ${Array.isArray(sources) ? sources.length : 0} 份资料`
  }).join("\n")}`)
  const unsorted = pages.get("wiki/topics/_unsorted.md")
  sections.push(`## 未归类\n- ${unsorted === undefined ? "未归类 · 暂无" : `[[_unsorted|未归类]] · ${countExcerptBlocks(unsorted)} 条待处理`}`)
  return `# 磁共振知识库目录\n\n${sections.join("\n\n")}\n`
}
export async function rebuildTopicIndex(projectPath: string, catalog: TopicCatalog): Promise<void> {
  await writeFile(`${projectPath}/wiki/index.md`, buildTopicIndex(catalog, await readTopicPages(projectPath)))
}
