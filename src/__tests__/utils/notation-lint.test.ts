import { lintScrapboxText, formatLintWarnings, getLintMode } from '@/utils/notation-lint.js';

describe('lintScrapboxText — decoration-inline-code', () => {
  it('flags inline code inside [* ]', () => {
    const warnings = lintScrapboxText('[* `usb-check.timer`の初回は翌月ではなくその月の15日]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe('decoration-inline-code');
    expect(warnings[0]!.line).toBe(1);
    expect(warnings[0]!.message).toContain('[* `usb-check.timer`の初回は翌月ではなくその月の15日]');
  });

  it('does NOT flag backticks outside the decoration', () => {
    expect(
      lintScrapboxText('[* 手順5・6のスクリプトは実装・テスト済み]。`~/dev/arigato-nas-ops/backup/`にあり')
    ).toEqual([]);
  });

  it('does NOT flag bracketed links inside a decoration', () => {
    // Verified against @progfay/scrapbox-parser: this renders as a proper decoration.
    expect(lintScrapboxText('[* [Plex]への影響は無い]')).toEqual([]);
    expect(lintScrapboxText('[* [exFAT]]')).toEqual([]);
    expect(lintScrapboxText('[* 教訓: [Immich]に取り込み済みかは[SHA1]で判定できる]')).toEqual([]);
  });

  it('flags a decoration that contains both a link and inline code', () => {
    // The link before the backtick must not hide the backtick from the scanner.
    const warnings = lintScrapboxText('[* 3. [Stash]（`/mnt/stash` 1.3T）はバックアップ対象外]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe('decoration-inline-code');
  });

  it('flags [/ ] and [- ] decorations too', () => {
    expect(lintScrapboxText('[/ `italic`]')[0]!.rule).toBe('decoration-inline-code');
    expect(lintScrapboxText('[- `struck`]')[0]!.rule).toBe('decoration-inline-code');
  });

  it('ignores ordinary links and unclosed brackets', () => {
    expect(lintScrapboxText('[Plex]と`code`は無関係')).toEqual([]);
    expect(lintScrapboxText('[* 閉じ忘れ `code`')).toEqual([]);
  });

  it('does not lint inside code blocks', () => {
    const text = ['code:sample.sh', ' echo "[* `not a decoration`]"'].join('\n');
    expect(lintScrapboxText(text)).toEqual([]);
  });

  it('resumes linting after a code block dedents', () => {
    const text = ['\tcode:sample.sh', '\t echo hi', '\t[* `broken`]'].join('\n');
    const warnings = lintScrapboxText(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.line).toBe(3);
  });

  it('reports each offending line with its own 1-based line number', () => {
    const text = ['ok line', '[* `a`]', 'ok', '[* `b`]'].join('\n');
    expect(lintScrapboxText(text).map(w => w.line)).toEqual([2, 4]);
  });
});

describe('lintScrapboxText — code-block-blank-line', () => {
  it('flags a blank line that splits a code block', () => {
    const text = [
      '\tcode:steps.sh',
      '\t step 1',
      '',
      '\t step 2',
    ].join('\n');
    const warnings = lintScrapboxText(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe('code-block-blank-line');
    expect(warnings[0]!.line).toBe(3);
  });

  it('does NOT flag a blank line that merely ends a code block', () => {
    // blankLineBeforeHeading=true puts a blank line before the next heading; the block is
    // already complete, so nothing falls out of the frame.
    const text = [
      '\tcode:layout.txt',
      '\t slot1',
      '\t slot2',
      '',
      '[* 次の見出し]',
    ].join('\n');
    expect(lintScrapboxText(text)).toEqual([]);
  });

  it('does NOT flag a blank line at the very end of the text', () => {
    expect(lintScrapboxText(['code:a.sh', ' body', ''].join('\n'))).toEqual([]);
  });

  it('flags each split independently', () => {
    const text = ['code:a.sh', ' one', '', ' two', '', ' three'].join('\n');
    // Only the first blank line is inside a code block; after it the block has ended,
    // so the second blank line is no longer part of one.
    const warnings = lintScrapboxText(text);
    expect(warnings.map(w => w.line)).toEqual([3]);
  });
});

describe('formatLintWarnings', () => {
  const warnings = lintScrapboxText('[* `a`]');

  it('says the write succeeded when saved', () => {
    const out = formatLintWarnings(warnings, true);
    expect(out).toContain('the write succeeded');
    expect(out).toContain('line 1 [decoration-inline-code]');
  });

  it('says nothing was written when blocked', () => {
    expect(formatLintWarnings(warnings, false)).toContain('nothing was written');
  });
});

describe('getLintMode', () => {
  const original = process.env.COSENSE_LINT;
  afterEach(() => {
    if (original === undefined) delete process.env.COSENSE_LINT;
    else process.env.COSENSE_LINT = original;
  });

  it('defaults to warn', () => {
    delete process.env.COSENSE_LINT;
    expect(getLintMode()).toBe('warn');
  });

  it('reads off and strict', () => {
    process.env.COSENSE_LINT = 'off';
    expect(getLintMode()).toBe('off');
    process.env.COSENSE_LINT = 'strict';
    expect(getLintMode()).toBe('strict');
  });

  it('falls back to warn on an unknown value', () => {
    process.env.COSENSE_LINT = 'banana';
    expect(getLintMode()).toBe('warn');
  });
});
