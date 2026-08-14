import { handleInsertLines } from '@/routes/handlers/insert-lines.js';
import { handleReplaceLines } from '@/routes/handlers/replace-lines.js';
import { handleCreatePage } from '@/routes/handlers/create-page.js';

jest.mock('@/utils/markdown-converter.js', () => ({
  convertMarkdownToScrapbox: jest.fn((text) => Promise.resolve(text)),
}));
jest.mock('@cosense/std/websocket', () => ({
  patch: jest.fn(),
}));
jest.mock('@/cosense.js', () => ({
  patch: jest.fn(),
  getPage: jest.fn(() => Promise.resolve(null)),
  createPageUrl: jest.fn(() => 'https://scrapbox.io/test/Page'),
}));

let mockedPatch: jest.MockedFunction<typeof import('@cosense/std/websocket').patch>;
beforeAll(async () => {
  const ws = await import('@cosense/std/websocket');
  mockedPatch = ws.patch as jest.MockedFunction<typeof ws.patch>;
});

const PROJECT = 'test-project';
const SID = 'test-sid';
/** A line that renders broken: inline code inside [* ] */
const BROKEN = '[* `usb-check.timer`の初回はその月の15日]';
/** Same content written correctly: backtick outside the decoration */
const CLEAN = '[* 初回はその月の15日]。`usb-check.timer`の話';

/** patch() succeeds and reports the target line as found. */
function mockPatchOk() {
  mockedPatch.mockImplementation(async (_p, _t, updater) => {
    if (typeof updater === 'function') {
      await (updater as (lines: unknown[]) => unknown)([
        { text: 'Test Page' },
        { text: 'target line' },
      ]);
    }
    return { ok: true, value: 'ok' } as never;
  });
}

describe('pre-write notation lint wiring', () => {
  const originalMode = process.env.COSENSE_LINT;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COSENSE_LINT;
    mockPatchOk();
  });

  afterAll(() => {
    if (originalMode === undefined) delete process.env.COSENSE_LINT;
    else process.env.COSENSE_LINT = originalMode;
  });

  describe('default (warn) mode', () => {
    it('insert_lines still writes, but reports the warning', async () => {
      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: BROKEN,
      });

      expect(result.isError).toBeUndefined();
      expect(mockedPatch).toHaveBeenCalled();
      expect(result.content?.[0]?.text).toContain('Successfully inserted');
      expect(result.content?.[0]?.text).toContain('decoration-inline-code');
    });

    it('replace_lines still writes, but reports the warning', async () => {
      const result = await handleReplaceLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        newText: BROKEN,
      });

      expect(mockedPatch).toHaveBeenCalled();
      expect(result.content?.[0]?.text).toContain('decoration-inline-code');
    });

    it('create_page still writes, but reports the warning', async () => {
      const result = await handleCreatePage(PROJECT, SID, {
        title: 'New Page',
        body: BROKEN,
      });

      expect(mockedPatch).toHaveBeenCalled();
      expect(result.content?.[0]?.text).toContain('decoration-inline-code');
    });

    it('says nothing when the notation is clean', async () => {
      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: CLEAN,
      });

      expect(result.content?.[0]?.text).not.toContain('Notation warnings');
    });

    it('reports a count in compact mode', async () => {
      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: BROKEN,
        compact: true,
      });

      expect(result.content?.[0]?.text).toContain('notation warnings: 1');
    });
  });

  describe('strict mode', () => {
    beforeEach(() => {
      process.env.COSENSE_LINT = 'strict';
    });

    it('rejects the write and does not call patch', async () => {
      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: BROKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('nothing was written');
      expect(mockedPatch).not.toHaveBeenCalled();
    });

    it('lets clean notation through', async () => {
      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: CLEAN,
      });

      expect(result.isError).toBeUndefined();
      expect(mockedPatch).toHaveBeenCalled();
    });
  });

  describe('off mode', () => {
    it('writes with no warning at all', async () => {
      process.env.COSENSE_LINT = 'off';

      const result = await handleInsertLines(PROJECT, SID, {
        pageTitle: 'Test Page',
        targetLineText: 'target line',
        text: BROKEN,
      });

      expect(mockedPatch).toHaveBeenCalled();
      expect(result.content?.[0]?.text).not.toContain('Notation warnings');
    });
  });
});
