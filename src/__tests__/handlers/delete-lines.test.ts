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
      expect(result.content[0]?.text).toContain('Multiple lines matched');
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
