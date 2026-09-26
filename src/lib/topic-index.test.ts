import { it, expect, vi } from "vitest"
import { parseTopicCatalog } from "./topic-catalog"
import { buildTopicIndex } from "./topic-index"
vi.mock("@/commands/fs", () => ({}))
it("counts sources, leaves absent topics unlinked and counts unsorted blocks", () => {
  const catalog = parseTopicCatalog(`version: 1\ncategories:\n- id: seq\n  name: 序列\n  topics:\n  - {id: dwi, name: 扩散}\n  - {id: epi, name: EPI}`)
  const result = buildTopicIndex(catalog, new Map([
    ["wiki/topics/seq/dwi.md", '---\nsources: [a, b]\n---\n'],
    ["wiki/topics/_unsorted.md", '<!-- excerpt:begin source="a" -->\n- x\n<!-- excerpt:end -->\n'],
  ]))
  expect(result).toContain("[[dwi|扩散]] · 2 份资料")
  expect(result).toContain("- EPI · 暂无")
  expect(result).toContain("[[_unsorted|未归类]] · 1 条待处理")
})
