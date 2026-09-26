/** Display-only: retain newlines so reader selection maps to original source lines. */
export function stripExcerptMarkers(markdown: string): string {
  return markdown.replace(/^[ \t]*<!-- excerpt:(?:begin\b[^\r\n]*|end[ \t]*)-->[ \t]*(?=\r?$)/gm, "")
}

/** Protect MRI symbols without rewriting existing Markdown code, math or links. */
export function protectStarSymbols(markdown: string): string {
  const protectedSpans = /(<[^>\n]+>|^ {0,3}\[[^\]\n]+\]:[^\n]*|https?:\/\/[^\s<>]+|^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2[^\n]*(?:\n|$)|^(?: {4}|\t)[^\n]*(?:\n|$)|(`+)[\s\S]*?\3|\$\$[\s\S]*?\$\$|\$[^\n$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|!?\[[^\]\n]*\]\([^\n)]*\))/gm
  const wrap = (text: string) => text.replace(/(?<![\w*\\])[A-Za-z]+\d+\*(?!\*)/g, symbol => `\`${symbol}\``)
  let result = "", cursor = 0
  for (const match of markdown.matchAll(protectedSpans)) {
    result += wrap(markdown.slice(cursor, match.index)) + match[0]
    cursor = match.index! + match[0].length
  }
  return result + wrap(markdown.slice(cursor))
}
