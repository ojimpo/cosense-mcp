import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { setupRoutes } from '@/routes/index.js';

jest.mock('@/cosense.js');
jest.mock('@cosense/std/websocket', () => ({ patch: jest.fn() }));

/**
 * 許可リストは各ハンドラではなく MCP のディスパッチ境界（routes/index.ts）で一度だけ見る。
 * 利用者ごとに許可範囲が違うので、判定は接続ごとの設定（allowedProjects）を引数で受ける。
 * ハンドラに判定を撒くと、ツールを足した人が忘れた時点で穴が開く。ここで全ツールを列挙して固定する。
 */
const TOOLS = [
  'list_pages', 'get_page', 'search_pages', 'create_page', 'get_page_url',
  'insert_lines', 'replace_lines', 'delete_lines', 'delete_page', 'rewrite_page',
  'rename_page', 'get_smart_context',
];

type CallTool = (request: { params: { name: string; arguments: Record<string, unknown> } }) =>
  Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function connect(allowedProjects: string[] | undefined): CallTool {
  let handler: CallTool | undefined;
  const server = {
    setRequestHandler: (_schema: unknown, fn: CallTool) => {
      handler = fn;
    },
  } as unknown as Server;
  setupRoutes(server, { projectName: 'kouki', cosenseSid: 'sid', allowedProjects, enableDelete: true });
  return handler!;
}

const call = (handler: CallTool, name: string, projectName: string) =>
  handler({ params: { name, arguments: { projectName, pageTitle: 'P', title: 'P', query: 'q', targetLineText: 'x', newText: 'y', newTitle: 'Q', text: 'z', body: 'b' } } });

describe('MCP ディスパッチ境界の COSENSE_PROJECT_ALLOW_LIST', () => {
  test.each(TOOLS)('%s: 許可外のプロジェクトは拒否される', async (tool) => {
    const result = await call(connect(['kouki', 'team']), tool, 'forbidden');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Project 'forbidden' is not allowed");
  });

  test.each(TOOLS)('%s: 空の許可リストは既定プロジェクト以外を拒否する', async (tool) => {
    const result = await call(connect([]), tool, 'team');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Project 'team' is not allowed");
  });

  test('許可リスト内のプロジェクトは境界を通る', async () => {
    const result = await call(connect(['kouki', 'team']), 'get_page_url', 'team');

    expect(result.content[0]?.text ?? '').not.toContain('is not allowed');
  });

  test('未設定なら無制限（従来どおり）', async () => {
    const result = await call(connect(undefined), 'get_page_url', 'anything');

    expect(result.content[0]?.text ?? '').not.toContain('is not allowed');
  });

  test('接続ごとに許可範囲が違っても、互いに影響しない', async () => {
    const narrow = connect(['shared']);
    const wide = connect(['kouki', 'team']);

    expect((await call(narrow, 'get_page_url', 'team')).isError).toBe(true);
    expect((await call(wide, 'get_page_url', 'team')).content[0]?.text ?? '').not.toContain('is not allowed');
  });
});
