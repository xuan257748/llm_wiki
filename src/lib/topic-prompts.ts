export const excerptPrompt = `You are building a topic-organized MRI knowledge base for an MRI clinical application engineer.
Your job: read ONE chunk of a source document and extract the MRI knowledge it contains, filed under the topics of the fixed catalog below.

Rules:
1. Only use topic ids from the catalog. Match by meaning and aliases (vendor product names, abbreviations, other languages all count).
2. File each piece of knowledge under the MOST SPECIFIC matching topic. A fact may be filed under at most 2 topics; do not copy the same text into many topics.
3. If the chunk contains real MRI knowledge that fits no catalog topic, use topic id \`_unsorted\` and add a line \`SUGGEST: <proposed topic name>\`.
4. Skip non-knowledge content: tables of contents, cover pages, copyright, contact info, agenda slides, pure navigation text, repeated headers/footers.
5. PRESERVE EXACT VALUES: parameter values, units, ranges, limits, protocol settings, UI parameter names, and tables must be copied exactly as in the source (tables as Markdown tables). Never turn a number into words like "higher" or "short".
6. Record the device model and software version ONLY if the source states them for this content. Never guess.
7. Record the location: use the page number from \`## Page N\` markers if present (e.g. \`p.12\` or \`p.12-14\`), otherwise the nearest section heading.
8. Write concise notes (bullet points), not a translation of the whole text, but keep every concrete detail (values, conditions, cause-effect, tradeoffs, vendor names).
9. Use ONLY information in this chunk. Do not add outside knowledge, do not explain beyond what the source says.
10. If an image reference like \`![...](...)\` in the chunk directly illustrates the extracted content (parameter card, protocol screenshot, diagram), you may keep it by copying the reference exactly. At most 3 images per excerpt.
11. If the chunk has no relevant MRI knowledge, output nothing.

<language rule from languageRule()>

Output ONLY blocks in this exact format, nothing else:

---EXCERPT: <topic-id>---
LOC: <p.N | section heading>
DEVICE: <device / software version, or omit this line>
SUGGEST: <only for _unsorted>
<markdown bullet notes>
---END EXCERPT---

## Topic Catalog
<rendered catalog>

## Wiki Purpose (context)
<purpose.md, if non-empty>`

export const sourceCardPrompt = `You write a short "source card" for an MRI knowledge base. Describe what this source is so the user can judge its scope and reliability later. Do not summarize its technical content in detail — that lives in topic pages.

Include:
- What kind of material it is (vendor training slides, operator manual, paper, textbook chapter, protocol sheet...)
- Author / organization and date if stated
- Device models and software versions it applies to, if stated
- 3-5 sentences on what it covers
- Reliability note: e.g. vendor training material vs peer-reviewed; anything version-specific

<language rule>
Frontmatter rules: same as existing source pages (type: source, title, created, updated, tags, sources: ["<sourceIdentity>"]); also add \`devices: [...]\` if known.
Do not write an "涉及主题" section; the application adds it deterministically.
Output exactly one FILE block using the literal delimiters below. Start with the ---FILE: line and finish with ---END FILE---. Do not wrap the block in Markdown code fences, do not use a bare FILE: label, and do not output any other paths or commentary.

---FILE: <sourceSummaryPath>---
---
type: source
title: <source title>
created: <current date YYYY-MM-DD>
updated: <current date YYYY-MM-DD>
tags: []
sources: []
---
# <source title>
<short source card in the requested language, following the rules above>
---END FILE---`
