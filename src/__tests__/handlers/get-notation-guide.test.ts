import { handleGetNotationGuide } from '@/routes/handlers/get-notation-guide.js';

jest.mock('@/cosense.js', () => ({
  getPage: jest.fn()
}));

let mockedGetPage: jest.MockedFunction<typeof import('@/cosense.js').getPage>;
beforeAll(async () => {
  const cosenseModule = await import('@/cosense.js');
  mockedGetPage = cosenseModule.getPage as jest.MockedFunction<typeof import('@/cosense.js').getPage>;
});

describe('handleGetNotationGuide', () => {
  const originalNotationConfig = process.env.COSENSE_NOTATION_CONFIG;
  const originalNotationPage = process.env.COSENSE_NOTATION_PAGE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COSENSE_NOTATION_CONFIG;
    delete process.env.COSENSE_NOTATION_PAGE;
  });

  afterAll(() => {
    if (originalNotationConfig !== undefined) process.env.COSENSE_NOTATION_CONFIG = originalNotationConfig;
    if (originalNotationPage !== undefined) process.env.COSENSE_NOTATION_PAGE = originalNotationPage;
  });

  test('returns the notation guide with default config', async () => {
    const result = await handleGetNotationGuide('test-project', 'test-sid');

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain("format='scrapbox'");
    expect(text).toContain('LINKS');
    expect(text).toContain('[* text]');
    expect(text).toContain('MATH (KaTeX)');
    // Default maxHeadingLevel is 1
    expect(text).toContain('Do NOT use [** text]');
    // COSENSE_NOTATION_PAGE 未設定ならカスタムルールには触れない
    // 未設定を無言で済ませると、受け手は「ルールが無い」のか
    // 「あるがこのデプロイが読んでいない」のか区別できない。
    // 2026-08-24 に既定値のガイドをプロジェクト方針と誤認して書いた事故の再発防止。
    expect(text).toContain('PROJECT CUSTOM RULES: not configured for this deployment');
    expect(text).toContain('COSENSE_NOTATION_PAGE is unset');
    // ベースガイドの出どころも明示する
    expect(text).toContain('GUIDE SOURCE:');
    expect(text).toContain('BUILT-IN DEFAULTS');
    expect(mockedGetPage).not.toHaveBeenCalled();
  });

  describe('COSENSE_NOTATION_PAGE が設定されている場合', () => {
    beforeEach(() => {
      process.env.COSENSE_NOTATION_PAGE = 'notation-rules';
    });

    test('設定ファイルを読んだ場合は出どころにそのパスを出す', async () => {
      const original = process.env.COSENSE_NOTATION_CONFIG;
      process.env.COSENSE_NOTATION_CONFIG = '/nonexistent/notation.config.json';
      try {
        const result = await handleGetNotationGuide('test-project', 'sid');
        const text = result.content[0]?.text ?? '';
        // 指定したのに読めなかったときは、既定値に落ちたことを隠さない
        expect(text).toContain('could not be read');
        expect(text).toContain('NOT in effect');
      } finally {
        if (original === undefined) delete process.env.COSENSE_NOTATION_CONFIG;
        else process.env.COSENSE_NOTATION_CONFIG = original;
      }
    });

    test('appends page content as PROJECT CUSTOM RULES', async () => {
      mockedGetPage.mockResolvedValue({
        lines: [
          { text: 'notation-rules' },
          { text: '箇条書きで簡潔に書く' },
          { text: '日付は[2026/7/19]形式でリンクにする' },
        ],
      } as Awaited<ReturnType<typeof import('@/cosense.js').getPage>>);

      const result = await handleGetNotationGuide('test-project', 'test-sid');
      const text = result.content[0]?.text ?? '';

      expect(mockedGetPage).toHaveBeenCalledWith('test-project', 'notation-rules', 'test-sid');
      expect(text).toContain('PROJECT CUSTOM RULES');
      expect(text).toContain('箇条書きで簡潔に書く');
      expect(text).toContain('日付は[2026/7/19]形式でリンクにする');
      // タイトル行はルールとして重複させない
      expect(text).toContain('Source: Cosense page "notation-rules"');
    });

    test('notes when the rules page is missing', async () => {
      mockedGetPage.mockResolvedValue(null);

      const result = await handleGetNotationGuide('test-project', 'test-sid');
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('was not found');
      expect(text).toContain('create_page');
    });

    test('notes when the rules page is empty', async () => {
      mockedGetPage.mockResolvedValue({
        lines: [{ text: 'notation-rules' }],
      } as Awaited<ReturnType<typeof import('@/cosense.js').getPage>>);

      const result = await handleGetNotationGuide('test-project', 'test-sid');
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('currently empty');
    });

    test('falls back to the base guide when fetch throws', async () => {
      mockedGetPage.mockRejectedValue(new Error('network error'));

      const result = await handleGetNotationGuide('test-project', 'test-sid');
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('LINKS');
      expect(text).toContain('failed to fetch');
      expect('isError' in result ? (result as { isError?: boolean }).isError : undefined).toBeUndefined();
    });

    test('skips page fetch when no project name is available', async () => {
      const result = await handleGetNotationGuide(undefined, undefined);
      const text = result.content[0]?.text ?? '';

      expect(mockedGetPage).not.toHaveBeenCalled();
      expect(text).toContain('LINKS');
      // 取りに行かなかった理由を言う
      expect(text).toContain('no project name is configured');
    });
  });
});
