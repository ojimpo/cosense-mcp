import { handleReplaceLines } from '@/routes/handlers/replace-lines.js';

jest.mock('@/utils/markdown-converter.js', () => ({
  convertMarkdownToScrapbox: jest.fn((text) => Promise.resolve(text))
}));
jest.mock('@cosense/std/websocket', () => ({
  patch: jest.fn()
}));

let mockedPatch: jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
beforeAll(async () => {
  const websocketModule = await import('@cosense/std/websocket');
  mockedPatch = websocketModule.patch as jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
});

describe('handleReplaceLines', () => {
  const mockProjectName = 'test-project';
  const mockCosenseSid = 'test-sid';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('エラーケース', () => {
    it('COSENSE_SIDが未設定の場合にエラーを返す', async () => {
      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        newText: 'replacement text',
      };

      const result = await handleReplaceLines(mockProjectName, undefined, params);

      expect(result).toEqual({
        content: [{
          type: "text",
          text: expect.stringContaining('Authentication required')
        }],
        isError: true
      });
    });

    it('対象行が見つからない場合にエラーを返す', async () => {
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'some line', id: 'l2' },
        ] as any;
        updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'nonexistent line',
        newText: 'replacement text',
      };
      const result = await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Target line not found');
    });

    it('複数行がマッチした場合にエラーを返す', async () => {
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'duplicate line', id: 'l2' },
          { text: 'other', id: 'l3' },
          { text: 'duplicate line', id: 'l4' },
        ] as any;
        updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'duplicate line',
        newText: 'replacement text',
      };
      const result = await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Multiple lines matched');
      expect(result.content[0]?.text).toContain('2 matches');
    });
  });

  describe('正常ケース', () => {
    test('基本的な行置換が成功すること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'old line', id: 'l2' },
          { text: 'other line', id: 'l3' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'old line',
        newText: 'new line',
      };
      const result = await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(result.content[0]?.text).toContain('Successfully replaced line');
      expect(result.content[0]?.text).toContain('Replacement lines: 1');
      expect(capturedResult).toHaveLength(3);
      expect(capturedResult[1]?.text).toBe('new line');
    });

    test('1行を複数行に置換できること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'old line', id: 'l2' },
          { text: 'other line', id: 'l3' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'old line',
        newText: 'new line 1\nnew line 2\nnew line 3',
      };
      const result = await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(result.content[0]?.text).toContain('Replacement lines: 3');
      expect(capturedResult).toHaveLength(5); // title + 3 new + other
      expect(capturedResult[1]?.text).toBe('new line 1');
      expect(capturedResult[2]?.text).toBe('new line 2');
      expect(capturedResult[3]?.text).toBe('new line 3');
      expect(capturedResult[4]?.text).toBe('other line');
    });

    test('完全一致のみマッチすること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'my TODO list', id: 'l2' },
          { text: 'TODO', id: 'l3' },
          { text: 'other', id: 'l4' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'TODO',
        newText: 'DONE',
      };
      await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(capturedResult[1]?.text).toBe('my TODO list'); // unchanged
      expect(capturedResult[2]?.text).toBe('DONE'); // replaced
    });

    test('patch が Result.Err を返した場合にエラーを返すこと', async () => {
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'target', id: 'l2' },
        ] as any;
        updateFn(mockLines, {} as any);
        return { ok: false, val: null, err: 'DisconnectReason' } as any;
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'target',
        newText: 'replacement',
      };
      const result = await handleReplaceLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('WebSocket patch failed');
    });
  });
});
