/**
 * Pre-write notation lint.
 *
 * Catches Cosense/Scrapbox notation that is syntactically accepted by the API but
 * renders incorrectly. The API stores whatever bytes we send — breakage happens at
 * render time, so the only place to catch it is before the write.
 *
 * Rules here are deliberately narrow: each one corresponds to a confirmed rendering
 * failure, verified against @progfay/scrapbox-parser (the parser Cosense renders with)
 * and against the live DOM.
 */

export type LintRule = 'decoration-inline-code' | 'code-block-blank-line';

export interface LintWarning {
  rule: LintRule;
  /** 1-based line number within the linted text (not the page) */
  line: number;
  /** The offending line, as given */
  text: string;
  message: string;
}

export type LintMode = 'off' | 'warn' | 'strict';

/**
 * Decoration marker characters, matching the parser's decorationRegExp:
 *   /\[[!"#%&'()*+,\-./{|}<>_~]+ (?:\[[^[\]]+\]|[^\]])+\]/
 */
const DECORATION_CHARS = new Set(`!"#%&'()*+,-./{|}<>_~`);

/** Read the lint mode from the environment. Defaults to 'warn'. */
export function getLintMode(): LintMode {
  const raw = (process.env.COSENSE_LINT ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === 'none') return 'off';
  if (raw === 'strict' || raw === 'error' || raw === 'reject') return 'strict';
  return 'warn';
}

/** Leading whitespace of a line (spaces and tabs both count as one indent step in Cosense). */
function indentOf(line: string): string {
  const m = /^[\t ]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * Find decorations (`[* ...]`, `[/ ...]`, `[- ...]`) that contain an inline-code backtick.
 *
 * Cosense tokenizes inline code BEFORE decorations (CodeNodeParser precedes
 * DecorationNodeParser in convertToNodes), so a backtick inside the brackets prevents the
 * decoration from ever matching. The `[*` and `]` then survive as literal text.
 *
 * Bracketed links inside a decoration are fine — `[* [Plex]への影響は無い]` renders
 * correctly — so bracket nesting is tracked rather than treated as a terminator.
 */
function findDecorationsWithInlineCode(line: string): string[] {
  const found: string[] = [];

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '[') continue;

    // Consume the run of decoration marker characters.
    let j = i + 1;
    while (j < line.length && DECORATION_CHARS.has(line[j] as string)) j++;
    if (j === i + 1) continue;      // no marker characters — an ordinary link
    if (line[j] !== ' ') continue;  // marker run must be followed by a space

    // Scan to the closing bracket the writer intended, tracking nested links.
    let depth = 1;
    let sawBacktick = false;
    let k = j + 1;
    for (; k < line.length; k++) {
      const c = line[k];
      if (c === '`') sawBacktick = true;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) continue;      // never closed — not an intended decoration
    if (sawBacktick) found.push(line.slice(i, k + 1));
    i = k;                          // continue after this decoration
  }

  return found;
}

/**
 * Lint a block of Cosense text.
 *
 * `text` may be a whole page body or just the fragment being inserted/replaced;
 * line numbers are relative to `text`.
 */
export function lintScrapboxText(text: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  const lines = text.split('\n');

  /** Indent width of the enclosing `code:` line, or null when not inside a code block. */
  let codeIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const indent = indentOf(line);
    const body = line.slice(indent.length);
    const isBlank = line.trim() === '';

    if (codeIndent !== null) {
      if (isBlank) {
        // A blank line terminates a code block. If deeper-indented content follows, the
        // writer meant it to stay inside the block — it will render as bare text instead.
        const next = lines.slice(i + 1).find(l => l.trim() !== '');
        if (next !== undefined && indentOf(next).length > codeIndent) {
          warnings.push({
            rule: 'code-block-blank-line',
            line: i + 1,
            text: line,
            message:
              'Blank line inside a code: block. A blank line terminates the block, so the ' +
              'lines below it fall outside the code frame and render as plain text. ' +
              'Split the block into separate code: blocks, or use a comment line (#) as a separator.',
          });
        }
        codeIndent = null;
        continue;
      }
      if (indent.length > codeIndent) continue; // still inside the block body — not parsed inline
      codeIndent = null;                        // dedented out of the block
    }

    if (/^code:/.test(body)) {
      codeIndent = indent.length;
      continue;
    }

    for (const raw of findDecorationsWithInlineCode(line)) {
      warnings.push({
        rule: 'decoration-inline-code',
        line: i + 1,
        text: line,
        message:
          `Inline code (backtick) inside a decoration: ${raw} — Cosense tokenizes inline code ` +
          'before decorations, so the decoration never forms and the literal "[*" and "]" are ' +
          'shown to the reader. Move the backticked term outside the brackets, ' +
          'e.g. [* label]。`code` rather than [* label `code`]. ' +
          '(Bracketed links inside a decoration are fine.)',
      });
    }
  }

  return warnings;
}

/** Render warnings as a human-readable block appended to a tool response. */
export function formatLintWarnings(warnings: LintWarning[], saved: boolean): string {
  const header = saved
    ? `Notation warnings (${warnings.length}) — the write succeeded, but these lines will render incorrectly. Fix them with replace_lines:`
    : `Notation errors (${warnings.length}) — nothing was written. Fix these and retry:`;

  return [
    header,
    ...warnings.map(w => `  line ${w.line} [${w.rule}]: ${w.text.trim()}\n    ${w.message}`),
  ].join('\n');
}
