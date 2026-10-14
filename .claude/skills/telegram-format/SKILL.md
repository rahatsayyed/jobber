---
name: telegram-format
description: Convert markdown text to Telegram-friendly HTML format. Use before sending any status/summary to Telegram via the reply tool.
---

# telegram-format

## Purpose

Convert standard markdown formatting into Telegram HTML so messages render correctly when sent via Telegram (bold, italic, lists, code, links all appear formatted).

## Input

A text string with standard markdown formatting:
- `**bold**` or `__bold__`
- `*italic*` or `_italic_`
- `- list item` (bullet lists)
- `` `inline code` `` (backtick-wrapped)
- ``` ```code block``` ``` (triple backtick)
- `[link text](url)`
- Headers: `## Header`, `### Subheader`, etc.
- Tables, horizontal rules, etc.

## Steps

1. Convert markdown → Telegram HTML using these rules:
   - `**text**` or `__text__` → `<b>text</b>`
   - `*text*` or `_text_` → `<i>text</i>`
   - `` `text` `` → `<code>text</code>`
   - ``` ```text``` ``` → `<pre><code>text</code></pre>`
   - `[text](url)` → `<a href="url">text</a>`
   - `## Header` → `<b>Header</b>` (preserve content, bold it, remove markdown marker)
   - `- item` (bullet list) → keep the item, keep `- ` as-is (Telegram renders these)
   - `|` table syntax → strip to plain text (Telegram doesn't support tables; format as text instead, e.g. "Field: value")
   - Preserve newlines, spacing, and paragraph breaks.

2. Handle edge cases:
   - Nested formatting: `**bold _italic_**` → `<b>bold <i>italic</i></b>`
   - Escape HTML special chars (`<`, `>`, `&`) in plain text if not part of a tag.
   - Preserve line breaks and blank lines (important for readability).

3. Return ONLY the converted HTML text — no wrapper, no explanation, no code fences.

## Output format

Plain Telegram HTML, ready to send via `telegram.reply({..., text: "<b>...</b>"})`.

Example input:
```
**Job Stats**

- Total discovered: 10
- Matched: 5

_Next step: email outreach_
```

Example output (raw, not in fences):
```
<b>Job Stats</b>

- Total discovered: 10
- Matched: 5

<i>Next step: email outreach</i>
```

## Notes

- Telegram HTML is more reliable than Telegram markdown for complex formatting.
- Do NOT convert inline `code` or code blocks to Telegram markdown backticks — use HTML tags instead.
- Do NOT add any HTML/body/doctype wrapper — just the content.
- Preserve blank lines between sections for readability.
