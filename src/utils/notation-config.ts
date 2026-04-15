import { readFileSync } from 'node:fs';

export interface NotationConfig {
  /** Max heading level: 1 = [* ] only, 2 = up to [** ], etc. (default: 1) */
  maxHeadingLevel?: 1 | 2 | 3 | 4 | undefined;
  /** Include KaTeX math syntax guidance (default: true) */
  mathEnabled?: boolean | undefined;
  /** Guide LLM to aggressively wrap nouns in brackets as links (default: true) */
  aggressiveLinking?: boolean | undefined;
  /** Additional custom rules appended to tool descriptions */
  customRules?: string[] | undefined;
}

const DEFAULT_CONFIG = {
  maxHeadingLevel: 1 as const,
  mathEnabled: true,
  aggressiveLinking: true,
};

export function loadNotationConfig(): NotationConfig {
  const configPath = process.env.COSENSE_NOTATION_CONFIG;
  if (!configPath) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as NotationConfig;
  } catch {
    return {};
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

/** Build the full body/text description for create_page */
export function buildFullDescription(config: NotationConfig): string {
  const maxLevel: number = config.maxHeadingLevel ?? DEFAULT_CONFIG.maxHeadingLevel;
  const mathEnabled: boolean = config.mathEnabled ?? DEFAULT_CONFIG.mathEnabled;
  const aggressiveLinking: boolean = config.aggressiveLinking ?? DEFAULT_CONFIG.aggressiveLinking;

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
 [[text]] = bold without size change
 [/ text] = italic, [- text] = strikethrough`);

  // Structure
  sections.push(`STRUCTURE:
 Lines starting with space(s) = bulleted list. More spaces = deeper nesting.
 Do NOT add blank lines between sections. Cosense pages are compact — use headings and indentation, NOT vertical whitespace.
 > quote for block quotes`);

  // Code
  sections.push(`CODE:
 Inline: \`code\`
 Block: "code:filename" followed by space-indented lines`);

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
    'Minimize blank lines. Zero blank lines between a heading and its content.',
  ];
  if (config.customRules) {
    rules.push(...config.customRules);
  }
  sections.push(`RULES:\n${rules.map(r => ` ${r}`).join('\n')}`);

  return `Content in Scrapbox/Cosense syntax. ALWAYS use format='scrapbox'.\n\n${sections.join('\n\n')}`;
}

/** Build the compact description for insert_lines/replace_lines text fields */
export function buildCompactDescription(config: NotationConfig, suffix: string): string {
  const maxLevel: number = config.maxHeadingLevel ?? DEFAULT_CONFIG.maxHeadingLevel;
  const mathEnabled: boolean = config.mathEnabled ?? DEFAULT_CONFIG.mathEnabled;
  const aggressiveLinking: boolean = config.aggressiveLinking ?? DEFAULT_CONFIG.aggressiveLinking;

  const lines: string[] = [
    `ALWAYS use format='scrapbox'. Same notation as create_page body:`,
  ];

  if (aggressiveLinking) {
    lines.push(' [page title] = internal link (use aggressively for all nouns/concepts/tools)');
  } else {
    lines.push(' [page title] = internal link');
  }

  if (maxLevel === 1) {
    lines.push(' [* heading] = section heading (the ONLY heading size — never use [** ] or larger)');
  } else {
    lines.push(` [* heading] = section heading (up to [${'*'.repeat(maxLevel)} ] max)`);
  }

  lines.push(' Space-indented lines = bullets. No unnecessary blank lines.');
  lines.push(' [[bold]], [/ italic], [- strikethrough], `inline code`');

  if (mathEnabled) {
    lines.push(' Math: [$ formula] (inline), [$$ formula] (block)');
  }

  lines.push(` ${suffix}`);

  return lines.join('\n');
}
