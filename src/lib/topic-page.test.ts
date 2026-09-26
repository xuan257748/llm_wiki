import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { parseTopicCatalog } from "./topic-catalog"
import { buildTopicPageSkeleton, upsertExcerptBlock, removeExcerptBlocks } from "./topic-page"
import { parseFrontmatter } from "./frontmatter"
vi.mock("@/commands/fs", () => ({}))
const catalog = parseTopicCatalog(readFileSync("tests/fixtures/topic-ingest/topics.yaml", "utf8"))
const skeleton = () => buildTopicPageSkeleton(catalog.categories[0].topics[3], catalog.categories[0], catalog, "2026-09-26")
describe("topic pages", () => {
  it("creates Chinese sections and related links", () => {
    expect(skeleton()).toContain("## 资料摘录")
    expect(skeleton()).toContain("[[epi|平面回波成像 EPI]]")
    expect(parseFrontmatter(skeleton()).frontmatter?.sources).toEqual([])
  })
  it("upserts in place, preserves manual text and supports quoted source identities", () => {
    const manual = "\n手写内容  \n\n```md\n## 资料摘录\n```\n"
    const original = skeleton().replace("## 原理\n（待整理）", "## 原理" + manual)
    const source = 'training/a"&-->b.pdf'
    let page = upsertExcerptBlock(original, source, "### p.1\n- 3 T\n## embedded heading\n| a | 1 |", "2026-09-26")
    page = upsertExcerptBlock(page, "b.pdf", "- second", "2026-09-26")
    page = upsertExcerptBlock(page, source, "- replacement", "2026-09-27")
    expect(page.match(/<!-- excerpt:begin/g)).toHaveLength(2)
    expect(page).toContain(manual)
    expect(page.indexOf("replacement")).toBeLessThan(page.indexOf("second"))
    expect(parseFrontmatter(page).frontmatter?.sources).toEqual([source, "b.pdf"])
    page = removeExcerptBlocks(page, source, "2026-09-28")
    expect(page).not.toContain("replacement")
    expect(page).toContain(manual)
    expect(parseFrontmatter(page).frontmatter?.sources).toEqual(["b.pdf"])
    expect(parseFrontmatter(page).frontmatter?.updated).toBe("2026-09-28")
  })
  it.each([true, false])("restores missing excerpt section with network section=%s", network => {
    let page = skeleton().replace("## 资料摘录\n", "")
    if (!network) page = page.replace("## 网络补充\n", "")
    page = upsertExcerptBlock(page, "a", "- text")
    expect(page).toContain("## 资料摘录\n")
    if (network) expect(page.indexOf("- text")).toBeLessThan(page.indexOf("## 网络补充"))
  })
  it("does not change unrelated frontmatter or sections", () => {
    const page = skeleton().replace("type: topic", "# keep comment\ntype: topic\ncustom:\n  nested: yes")
    const next = upsertExcerptBlock(page, "a", "- data")
    expect(next).toContain("# keep comment\ntype: topic\ncustom:\n  nested: yes")
    expect(removeExcerptBlocks(next, "absent")).toBe(next)
  })
})
