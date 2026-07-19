import { handleDeleteLines } from '@/routes/handlers/delete-lines.js';

jest.mock('@cosense/std/websocket', () => ({
  patch: jest.fn()
}));

let mockedPatch: jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
beforeAll(async () => {
  const websocketModule = await import('@cosense/std/websocket');
  mockedPatch = websocketModule.patch as jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
});

describe('handleDeleteLines', () => {
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
      };

      const result = await handleDeleteLines(mockProjectName, undefined, params);

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
      };
      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Target line not found');
    });

    it('複数行がマッチした場合にエラーを返す', async () => {
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'duplicate', id: 'l2' },
          { text: 'other', id: 'l3' },
          { text: 'duplicate', id: 'l4' },
        ] as any;
        updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'duplicate',
      };
      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Multiple locations matched');
      expect(result.content[0]?.text).toContain('2 matches');
    });
  });

  describe('正常ケース', () => {
    test('基本的な行削除が成功すること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'line to delete', id: 'l2' },
          { text: 'remaining line', id: 'l3' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const params = {
        pageTitle: 'Test Page',
        targetLineText: 'line to delete',
      };
      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, params);

      expect(result.content[0]?.text).toContain('Successfully deleted line');
      expect(capturedResult).toHaveLength(2);
      expect(capturedResult[0]?.text).toBe('title');
      expect(capturedResult[1]?.text).toBe('remaining line');
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
      };
      await handleDeleteLines(mockProjectName, mockCosenseSid, params);

      expect(capturedResult).toHaveLength(3);
      expect(capturedResult[1]?.text).toBe('my TODO list'); // unchanged
      // 'TODO' is deleted, 'other' moves up
      expect(capturedResult[2]?.text).toBe('other');
    });

    test('occurrence指定で重複行のN番目を削除できること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'duplicate', id: 'l2' },
          { text: 'other', id: 'l3' },
          { text: 'duplicate', id: 'l4' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, {
        pageTitle: 'Test Page',
        targetLineText: 'duplicate',
        occurrence: 2,
      });

      expect(result.isError).toBeUndefined();
      expect(capturedResult).toHaveLength(3);
      expect(capturedResult[1]?.text).toBe('duplicate'); // 1つ目は残る
      expect(capturedResult[2]?.text).toBe('other');
    });

    test('occurrenceが範囲外の場合にエラーを返すこと', async () => {
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'duplicate', id: 'l2' },
          { text: 'duplicate', id: 'l3' },
        ] as any;
        updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, {
        pageTitle: 'Test Page',
        targetLineText: 'duplicate',
        occurrence: 3,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('out of range');
    });

    test('複数行ブロックをまとめて削除できること', async () => {
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'keep', id: 'l2' },
          { text: 'block line 1', id: 'l3' },
          { text: 'block line 2', id: 'l4' },
          { text: 'block line 3', id: 'l5' },
          { text: 'tail', id: 'l6' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, {
        pageTitle: 'Test Page',
        targetLineText: 'block line 1\nblock line 2\nblock line 3',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('Deleted lines: 3');
      expect(capturedResult.map((l: any) => l.text)).toEqual(['title', 'keep', 'tail']);
    });

    test('重複ブロックをoccurrenceで選んで削除できること', async () => {
      // 実発生ケース: 同一の3行ブロックが2箇所にあり、2つ目だけ消したい
      let capturedResult: any;
      mockedPatch.mockImplementation(async (_project, _title, updateFn) => {
        const mockLines = [
          { text: 'title', id: 'l1' },
          { text: 'summary', id: 'l2' },
          { text: 'fact A', id: 'l3' },
          { text: '#tag', id: 'l4' },
          { text: 'meaning', id: 'l5' },
          { text: 'summary', id: 'l6' },
          { text: 'fact A', id: 'l7' },
          { text: '#tag', id: 'l8' },
        ] as any;
        capturedResult = updateFn(mockLines, {} as any);
        return { ok: true, val: 'commitId', err: null };
      });

      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, {
        pageTitle: 'Test Page',
        targetLineText: 'summary\nfact A\n#tag',
        occurrence: 2,
      });

      expect(result.isError).toBeUndefined();
      expect(capturedResult.map((l: any) => l.text)).toEqual(['title', 'summary', 'fact A', '#tag', 'meaning']);
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
      };
      const result = await handleDeleteLines(mockProjectName, mockCosenseSid, params);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('WebSocket patch failed');
    });
  });
});
