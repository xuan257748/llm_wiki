import { describe, it, expect } from "vitest"
import { parseTopicCatalog, renderTopicCatalog } from "./topic-catalog"
import { parseExcerptBlocks } from "./topic-excerpt"
export const catalogText = `version: 1
categories:
  - id: sequences
    name: 序列
    topics:
      - id: dwi
        name: 扩散
        aliases: [DWI, b值]
        related: [epi, missing]
      - id: epi
        name: EPI
        aliases: []
`
describe("topic catalog", () => {
  it("validates and renders with dangling-related warnings", () => {
    const c = parseTopicCatalog(catalogText)
    expect(c.warnings).toHaveLength(1)
    expect(renderTopicCatalog(c)).toContain("dwi | 扩散 | 别名: DWI, b值")
  })
  it.each([
    catalogText.replace("id: dwi", "id: ../dwi"),
    catalogText.replace("id: epi", "id: dwi"),
    catalogText.replace("version: 1", "version: 2"),
    "version: 1\ncategories: null",
  ])("rejects malformed catalogs", text => expect(() => parseTopicCatalog(text)).toThrow())
})
describe("excerpt parser", () => {
  it("preserves values, optional fields and order; redirects unknown topics", () => {
    const r = parseExcerptBlocks(`---EXCERPT: dwi---\nLOC: p.12\nDEVICE: Aera / E11\n- b = 1000 s/mm²\n---END EXCERPT---\n---EXCERPT: new-topic---\nSUGGEST: 新主题\n- 3 T\n---END EXCERPT---`, parseTopicCatalog(catalogText))
    expect(r.excerpts.map(e => e.topicId)).toEqual(["dwi", "_unsorted"])
    expect(r.excerpts[0]).toMatchObject({ location: "p.12", device: "Aera / E11", body: "- b = 1000 s/mm²" })
    expect(r.warnings).toHaveLength(1)
  })
  it("drops empty and unclosed blocks and recovers later blocks", () => {
    const r = parseExcerptBlocks(`---EXCERPT: dwi---\nLOC: p.1\n---END EXCERPT---\n---EXCERPT: dwi---\n- truncated\n---EXCERPT: epi---\n- valid\n---END EXCERPT---`, parseTopicCatalog(catalogText))
    expect(r.excerpts).toHaveLength(1)
    expect(r.excerpts[0].topicId).toBe("epi")
    expect(r.warnings).toHaveLength(1)
  })
})
