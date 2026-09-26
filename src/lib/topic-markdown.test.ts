import { describe, expect, it } from "vitest"
import { protectStarSymbols, stripExcerptMarkers } from "./topic-markdown"
import { currentWikiDate } from "./wiki-date"

describe("topic display and symbols", () => {
  it("hides only boundary lines while retaining source line positions", () => {
    const input = '# Topic\r\n<!-- excerpt:begin source="a.md" -->\r\nT2*\r\n<!-- excerpt:end -->\r\n<!-- other -->\r\ninline <!-- excerpt:end -->'
    expect(stripExcerptMarkers(input)).toBe('# Topic\r\n\r\nT2*\r\n\r\n<!-- other -->\r\ninline <!-- excerpt:end -->')
  })
  it("protects bare symbols and is idempotent", () => {
    const input = 'T2*、R2* and T1. **加粗** **T2** T2**'
    const output = '`T2*`、`R2*` and T1. **加粗** **T2** T2**'
    expect(protectStarSymbols(input)).toBe(output)
    expect(protectStarSymbols(output)).toBe(output)
  })
  it("preserves code, math, links, escapes and indented code", () => {
    const input = '`T2*` ``R2*`` $T2*$ $$R2*$$ \\(T2*\\) \\[R2*\\]\n```text\nT2*\n```\n~~~\nR2*\n~~~\n    T2*\n[x](https://x/T2*) T2\\*'
    expect(protectStarSymbols(input)).toBe(input)
  })
  it("preserves autolinks, bare URLs and reference link destinations", () => {
    const input = '<https://example.org/T2*>\n[paper]: https://example.org/R2*\nhttps://example.org/T2*'
    expect(protectStarSymbols(input)).toBe(input)
  })
  it("uses local date fields rather than UTC", () => {
    const date = new Date(2026, 8, 27, 0, 15)
    expect(currentWikiDate(date)).toBe('2026-09-27')
  })
})
