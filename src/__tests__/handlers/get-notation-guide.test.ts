import { handleGetNotationGuide } from '@/routes/handlers/get-notation-guide.js';

describe('handleGetNotationGuide', () => {
  const originalEnv = process.env.COSENSE_NOTATION_CONFIG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COSENSE_NOTATION_CONFIG;
    } else {
      process.env.COSENSE_NOTATION_CONFIG = originalEnv;
    }
  });

  test('returns the notation guide with default config', async () => {
    delete process.env.COSENSE_NOTATION_CONFIG;
    const result = await handleGetNotationGuide();

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain("format='scrapbox'");
    expect(text).toContain('LINKS');
    expect(text).toContain('[* text]');
    expect(text).toContain('MATH (KaTeX)');
    // Default maxHeadingLevel is 1
    expect(text).toContain('Do NOT use [** text]');
  });

  test('does not set isError', async () => {
    const result = await handleGetNotationGuide();
    expect('isError' in result ? (result as { isError?: boolean }).isError : undefined).toBeUndefined();
  });
});
