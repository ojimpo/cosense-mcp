import { readFileSync } from 'node:fs';

export interface NotationConfig {
  /** Max heading level: 1 = [* ] only, 2 = up to [** ], etc. (default: 1) */
  maxHeadingLevel?: 1 | 2 | 3 | 4 | undefined;
  /** Include KaTeX math syntax guidance (default: true) */
  mathEnabled?: boolean | undefined;
  /** Guide LLM to aggressively wrap nouns in brackets as links (default: true) */
  aggressiveLinking?: boolean | undefined;
  /** Insert one blank line before each heading to separate sections (heading still sticks to its content; default: false) */
  blankLineBeforeHeading?: boolean | undefined;
  /** Additional custom rules appended to tool descriptions */
  customRules?: string[] | undefined;
}

const DEFAULT_CONFIG = {
  maxHeadingLevel: 1 as const,
  mathEnabled: true,
  aggressiveLinking: true,
  blankLineBeforeHeading: false,
};

/**
 * 設定がどこから来たか。ガイドの受け手（LLM）が「既定値を見ているのか、
 * 設定を読んだ結果を見ているのか」を区別できないと、設定漏れに気づけない。
 */
export type NotationConfigSource =
  | { kind: 'defaults' }
  | { kind: 'file'; path: string }
  | { kind: 'file-error'; path: string; reason: string };

export interface LoadedNotationConfig {
  config: NotationConfig;
  source: NotationConfigSource;
}

export function loadNotationConfig(): LoadedNotationConfig {
  const configPath = process.env.COSENSE_NOTATION_CONFIG;
  if (!configPath) return { config: {}, source: { kind: 'defaults' } };

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return { config: JSON.parse(raw) as NotationConfig, source: { kind: 'file', path: configPath } };
  } catch (error) {
    // 設定ファイルを指定したのに読めない場合、黙って既定値に落ちると
    // 「意図した設定が効いている」と誤認させる。素性として持ち回して報告する。
    return {
      config: {},
      source: {
        kind: 'file-error',
        path: configPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** ガイド末尾に付ける、設定の出どころの1行。 */
export function describeConfigSource(source: NotationConfigSource): string {
  switch (source.kind) {
    case 'file':
      return `Base guide built from COSENSE_NOTATION_CONFIG (${source.path}).`;
    case 'file-error':
      return `Base guide built from BUILT-IN DEFAULTS: COSENSE_NOTATION_CONFIG points at ${source.path} but it could not be read (${source.reason}). The intended settings are NOT in effect.`;
    case 'defaults':
      return 'Base guide built from BUILT-IN DEFAULTS (COSENSE_NOTATION_CONFIG is unset).';
  }
}

function buildHeadingGuide(maxLevel: number): string {
  const lines: string[] = [];

  if (maxLevel >= 1) {
    lines.push(' [* text] = bold heading (use for section headings)');
  }
  if (maxLevel >= 2) {
    lines.push(' [** text] = larger bold (use sparingly, for major sections only)');
  }
  if (maxLevel >= 3) {
    lines.push(' [*** text] = very large bold (rarely needed)');
  }
  if (maxLevel >= 4) {
    lines.push(' [**** text] = largest bold (almost never use)');
  }

  // Add restriction note
  if (maxLevel === 1) {
    lines.push(' Do NOT use [** text], [*** text], or [**** text] — only [* ] is allowed for headings.');
  } else if (maxLevel <= 3) {
    const forbidden = Array.from({ length: 4 - maxLevel }, (_, i) => `[${'*'.repeat(maxLevel + i + 1)} ]`).join(', ');
    lines.push(` Do NOT use ${forbidden} — too large.`);
  }

  return lines.join('\n');
}

/** Build the full notation guide returned by the get_notation_guide tool */
export function buildNotationGuide(config: NotationConfig): string {
  const maxLevel: number = config.maxHeadingLevel ?? DEFAULT_CONFIG.maxHeadingLevel;
  const mathEnabled: boolean = config.mathEnabled ?? DEFAULT_CONFIG.mathEnabled;
  const aggressiveLinking: boolean = config.aggressiveLinking ?? DEFAULT_CONFIG.aggressiveLinking;
  const blankLineBeforeHeading: boolean = config.blankLineBeforeHeading ?? DEFAULT_CONFIG.blankLineBeforeHeading;

  const sections: string[] = [];

  // Links
  if (aggressiveLinking) {
    sections.push(`LINKS — the CORE VALUE of Cosense:
 [page title] creates internal links. AGGRESSIVELY wrap nouns, product names, concepts, tools, people in brackets. Example: "[PowerToys]で[Caps Lock]→[Ctrl]にリマップ"
 External links: [https://example.com Label] or [Label https://example.com]
 #tag is equivalent to [tag]`);
  } else {
    sections.push(`LINKS:
 [page title] creates internal links. Wrap relevant terms in brackets where appropriate.
 External links: [https://example.com Label] or [Label https://example.com]
 #tag is equivalent to [tag]`);
  }

  // Text formatting
  sections.push(`TEXT FORMATTING:
${buildHeadingGuide(maxLevel)}
 For inline emphasis (including inside table cells), use [* text]. Do NOT use [[text]] for bold — it renders as bold-ish but is easily confused with internal links, and notably does NOT bold inside table cells.
 [/ text] = italic, [- text] = strikethrough
 NEVER put inline code (backticks) inside [* ], [/ ] or [- ]. Cosense tokenizes inline code BEFORE decorations, so the decoration never forms and the reader sees a literal "[*" and "]". Move the backticked term outside the brackets.
   BAD:  [* \`usb-check.timer\`の初回はその月の15日]
   GOOD: [* 初回はその月の15日]。\`usb-check.timer\`の話
 Bracketed links inside a decoration ARE fine: [* [Plex]への影響は無い] renders correctly.`);

  // Structure
  const blankLineRule = blankLineBeforeHeading
    ? 'Insert ONE blank line BEFORE each heading (except the first heading at the top of the page) to separate sections. Heading and its content stick together — zero blank lines between them. No other blank lines.'
    : 'Do NOT add blank lines between sections. Cosense pages are compact — use headings and indentation, NOT vertical whitespace.';
  sections.push(`STRUCTURE:
 Lines starting with space(s) = bulleted list. More spaces = deeper nesting.
 ${blankLineRule}
 > quote for block quotes`);

  // Code
  sections.push(`CODE:
 Inline: \`code\`
 Block: a "code:filename" line, followed by body lines each indented ONE space deeper than the "code:" line.
 INDENT CONSISTENCY IS MANDATORY: place "code:" at the SAME indent as its sibling bullets, then indent every body line exactly one more space. Getting this wrong breaks rendering.
 NEVER put a blank line inside a code block. A blank line TERMINATES the block, so everything below it falls outside the code frame. To break up a long procedure, split it into several code: blocks with explanatory bullets between them, or use a comment line (#) as a separator.
 Example inside a nested [* section] (the section's content sits at one indent; the code block sits there too):
   [* section]
    intro bullet
    code:example.txt
     body line 1
     body line 2
    next bullet`);

  // Math
  if (mathEnabled) {
    sections.push(`MATH (KaTeX):
 Inline: [$ e^{i\\pi} + 1 = 0]
 Block: [$$  \\sum_{i=1}^{n} x_i]`);
  }

  // Rules
  const rules = [
    'Do NOT duplicate the title (auto-displayed at top).',
    'Write concisely in bullet points, not prose paragraphs.',
    blankLineBeforeHeading
      ? 'Minimize blank lines — EXCEPT exactly one blank line immediately BEFORE each heading (skip for the first heading at the top). Zero blank lines between a heading and its content.'
      : 'Minimize blank lines. Zero blank lines between a heading and its content.',
  ];
  if (config.customRules) {
    rules.push(...config.customRules);
  }
  sections.push(`RULES:\n${rules.map(r => ` ${r}`).join('\n')}`);

  return `Cosense/Scrapbox notation guide — apply these rules to ALL page content. ALWAYS use format='scrapbox'.\n\n${sections.join('\n\n')}`;
}
