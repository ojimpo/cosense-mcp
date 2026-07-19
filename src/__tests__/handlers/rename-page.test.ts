import { handleRenamePage } from '@/routes/handlers/rename-page.js';

jest.mock('@cosense/std/websocket', () => ({
  patch: jest.fn()
}));

jest.mock('@/cosense.js', () => {
  const actual = jest.requireActual('@/cosense.js');
  return {
    ...actual,
    getPage: jest.fn(),
  };
});

let mockedPatch: jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
let mockedGetPage: jest.MockedFunction<typeof import('@/cosense.js').getPage>;
beforeAll(async () => {
  const websocketModule = await import('@cosense/std/websocket');
  mockedPatch = websocketModule.patch as jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
  const cosenseModule = await import('@/cosense.js');
  mockedGetPage = cosenseModule.getPage as jest.MockedFunction<typeof import('@/cosense.js').getPage>;
});

type MockPage = Awaited<ReturnType<typeof import('@/cosense.js').getPage>>;

function makePage(overrides: Record<string, unknown> = {}): MockPage {
  return {
    title: 'Old Title',
    lines: [{ text: 'Old Title' }, { text: 'body line' }],
    links: [],
    relatedPages: { links1hop: [] },
    persistent: true,
    ...overrides,
  } as MockPage;
}

describe('handleRenamePage', () => {
  const mockProjectName = 'test-project';
  const mockCosenseSid = 'test-sid';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('エラーケース', () => {
    it('COSENSE_SIDが未設定の場合にエラーを返す', async () => {
      const result = await handleRenamePage(mockProjectName, undefined, {
        pageTitle: 'Old Title',
        newTitle: 'New Title',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Authentication required');
    });

    it('新タイトルが空の場合にエラーを返す', async () => {
      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Old Title',
        newTitle: '  ',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('must not be empty');
    });

    it('新旧タイトルが同一の場合にエラーを返す', async () => {
      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Same',
        newTitle: 'Same',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('identical');
    });

    it('リネーム元ページが存在しない場合にエラーを返す', async () => {
      mockedGetPage.mockResolvedValue(null);

      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Missing Page',
        newTitle: 'New Title',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Page not found');
      expect(mockedPatch).not.toHaveBeenCalled();
    });

    it('リネーム先ページが既に存在する場合にエラーを返す', async () => {
      mockedGetPage
        .mockResolvedValueOnce(makePage())
        .mockResolvedValueOnce(makePage({ title: 'New Title' }));

      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Old Title',
        newTitle: 'New Title',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('already exists');
      expect(mockedPatch).not.toHaveBeenCalled();
    });
  });

  describe('正常ケース', () => {
    it('タイトル行だけを書き換えること', async () => {
      mockedGetPage
        .mockResolvedValueOnce(makePage())
        .mockResolvedValueOnce(null); // 新タイトルは未使用

      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'Old Title', id: 'l1' },
          { text: 'body line', id: 'l2' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Old Title',
        newTitle: 'New Title',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('Successfully renamed page');
      expect(capturedResult[0]?.text).toBe('New Title');
      expect(capturedResult[1]?.text).toBe('body line');
      expect(capturedResult).toHaveLength(2);
    });

    it('バックリンク候補（被リンクのみのページ）を警告に含めること', async () => {
      mockedGetPage
        .mockResolvedValueOnce(makePage({
          links: ['Outgoing Page'],
          relatedPages: {
            links1hop: [
              { title: 'Outgoing Page', descriptions: [] },
              { title: 'Backlink Page', descriptions: [] },
            ],
          },
        }))
        .mockResolvedValueOnce(null);

      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        updateFn([{ text: 'Old Title', id: 'l1' }] as any, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Old Title',
        newTitle: 'New Title',
      });

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('NOT updated automatically');
      expect(text).toContain('Backlink Page');
      expect(text).not.toContain('- Outgoing Page');
    });

    it('patch が Result.Err を返した場合にエラーを返すこと', async () => {
      mockedGetPage
        .mockResolvedValueOnce(makePage())
        .mockResolvedValueOnce(null);
      mockedPatch.mockResolvedValue({ ok: false, val: null, err: 'SomeError' } as any);

      const result = await handleRenamePage(mockProjectName, mockCosenseSid, {
        pageTitle: 'Old Title',
        newTitle: 'New Title',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('WebSocket patch failed');
    });
  });
});
