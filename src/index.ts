#!/usr/bin/env node

// CLI mode detection: 引数があればCLIモード、なければMCPサーバーモード
const _firstArg = process.argv[2];
if (_firstArg) {
  const { runCli } = await import('./cli.js');
  await runCli(process.argv.slice(2));
  process.exit(0);
}

const SERVICE_LABEL = process.env.SERVICE_LABEL || "cosense (scrapbox)";
const TOOL_SUFFIX = process.env.COSENSE_TOOL_SUFFIX;
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

// package.json を唯一のバージョン情報源にする（リリース時のズレ防止）
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
import { listPages, getPage, toReadablePage } from "./cosense.js";
import { formatYmd } from './utils/format.js';
import { setupRoutes } from './routes/index.js';
import { isDeleteEnabled } from './routes/handlers/delete-page.js';
import { DEFAULT_LIST_LIMIT, DEFAULT_LIST_SORT } from './routes/handlers/list-pages.js';
import { getProjectAllowList } from './utils/project.js';
import { defaultSession, describeProjectName, resolveSessionConfig, type SessionConfig, type SessionDefaults } from './session.js';

// 環境変数のデフォルト値と検証用の定数
const FETCH_PAGE_LIMIT = 100;  // 固定で100件取得
const DEFAULT_PAGE_LIMIT = FETCH_PAGE_LIMIT;  // デフォルトは取得上限と同じ
const DEFAULT_SORT_METHOD = 'updated';
const MIN_PAGE_LIMIT = 1;
const MAX_PAGE_LIMIT = 1000;

// 有効なソート方法の定義
const VALID_SORT_METHODS = ['updated', 'created', 'accessed', 'linked', 'views', 'title'] as const;

// ツール名生成ヘルパー
function getToolName(baseName: string): string {
  return TOOL_SUFFIX ? `${baseName}_${TOOL_SUFFIX}` : baseName;
}

// resourcesの初期取得用の設定
const cosenseSid: string | undefined = process.env.COSENSE_SID;
const projectName: string | undefined = process.env.COSENSE_PROJECT_NAME;
const initialPageLimit: number = (() => {
  const limit = process.env.COSENSE_PAGE_LIMIT ?
    parseInt(process.env.COSENSE_PAGE_LIMIT, 10) :
    DEFAULT_PAGE_LIMIT;

  if (isNaN(limit) || limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
    return DEFAULT_PAGE_LIMIT;
  }
  return limit;
})();

const initialSortMethod: string = (() => {
  const sort = process.env.COSENSE_SORT_METHOD;

  if (!sort) return DEFAULT_SORT_METHOD;
  if (!VALID_SORT_METHODS.includes(sort as any)) {
    return DEFAULT_SORT_METHOD;
  }
  return sort;
})();

if (!projectName) {
  throw new Error("COSENSE_PROJECT_NAME is not set");
}


// resourcesの初期化（100件取得してソート）
const resources = await (async () => {
  try {
    // 常に100件取得
    const result = await listPages(
      projectName,
      cosenseSid,
      {
        limit: FETCH_PAGE_LIMIT,  // 固定で100件
        skip: 0,
        sort: initialSortMethod,
        excludePinned: process.env.COSENSE_EXCLUDE_PINNED === 'true'
      }
    );

    // ソート済みのページから必要な件数だけを使用
    return result.pages
      .slice(0, Math.min(initialPageLimit, FETCH_PAGE_LIMIT))  // 環境変数で指定された件数か100件の小さい方
      .map((page) => ({
        uri: `cosense:///${page.title}`,
        mimeType: "text/plain",
        name: page.title,
        description: `A text page: ${page.title}`,
      }));

  } catch (error) {
    return [];  // 空の配列を返してサーバーは起動を継続
  }
})();

// 記法カスタマイズ設定の読み込み
// 記法ガイド本文は get_notation_guide ツールのレスポンスで返す（descriptionを安定させ、
// ガイド更新時にClaude.ai側のtools/list再取得（コネクタ再登録）を不要にするため）
const notationPointer = "ALWAYS use format='scrapbox'. REQUIRED: call get_notation_guide once per conversation BEFORE composing content, and follow it exactly — it contains the current notation rules (headings, links, blank lines, code blocks, project-specific rules). Core syntax: [page title] = internal link, [* text] = heading/emphasis, space-indented lines = bullets.";
const bodyDescription = `Page content in Scrapbox/Cosense syntax. ${notationPointer} Do NOT duplicate the page title in the body (auto-displayed at top).`;
const insertTextDescription = `${notationPointer} Can contain multiple lines separated by newline characters.`;
const replaceTextDescription = `${notationPointer} Can contain multiple lines (replaces 1 line with multiple lines).`;

/** 環境変数だけから決まる既定値。stdio と、利用者が特定できない接続で使う。 */
function sessionDefaults(): SessionDefaults {
  return {
    projectName: projectName!,
    cosenseSid: cosenseSid ?? undefined,
    allowedProjects: getProjectAllowList(),
    enableDelete: isDeleteEnabled(),
  };
}

// サーバー生成ファクトリ（HTTP transportでセッションごとに新しいサーバーを作成するため関数化）
function createServer(session: SessionConfig = defaultSession(sessionDefaults())): Server {
  const server = new Server(
    {
      name: "scrapbox-cosense-mcp",
      version,
      icons: [
        { src: "https://scrapbox.io/favicon.ico", mimeType: "image/x-icon", sizes: ["32x32"] },
      ],
    },
    {
      capabilities: {
        resources: {},
        // listChanged: 現状Anthropic製クライアントは通知を無視するが、仕様準拠のため宣言しておく
        tools: { listChanged: true },
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // resources は起動時に既定プロジェクトから一度だけ取得したもの。
    // 利用者ごとに設定が違う接続へ返すと、その人が触れないプロジェクトの
    // ページ一覧をそのまま渡すことになる。
    return {
      resources: session.isDefaultSession ? resources : [],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const url = new URL(request.params.uri);
    const title = decodeURIComponent(url.pathname.replace(/^\//, ""));

    const getPageResult = await getPage(session.projectName, title, session.cosenseSid);
    if (!getPageResult) {
      throw new Error(`Page ${title} not found`);
    }
    const readablePage = toReadablePage(getPageResult);
    const formattedText = [
      `Title: ${readablePage.title}`,
      `Created: ${formatYmd(new Date(readablePage.created * 1000))}`,
      `Updated: ${formatYmd(new Date(readablePage.updated * 1000))}`,
      `Created user: ${readablePage.lastUpdateUser?.displayName || readablePage.user.displayName}`,
      `Last editor: ${readablePage.user.displayName}`,
      `Other editors: ${readablePage.collaborators
        .filter(collab =>
          collab.id !== readablePage.user.id &&
          collab.id !== readablePage.lastUpdateUser?.id
        )
        .map(user => user.displayName)
        .join(', ')}`,
      '',
      readablePage.lines.map(line => line.text).join('\n'),
      '',
      `Links:\n${getPageResult.links.length > 0
        ? getPageResult.links.map((link: string) => `- ${link}`).join('\n')
        : '(None)'}`
    ].join('\n');

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain",
          text: formattedText,
        },
      ],
    };
  });

  // この SDK は capabilities で宣言したメソッドしかハンドラ登録できないため、
  // prompts / resource templates は宣言とセットで空の list ハンドラを用意する。
  // 未登録のままだと Claude.ai の probe が -32601 Method not found を受ける。
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: [] };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const projectNameDescription = describeProjectName(session);
    const tools = [
        {
          name: getToolName("get_notation_guide"),
          description: `Get the current Cosense/Scrapbox notation guide for ${SERVICE_LABEL} (headings, links, lists, code blocks, math, blank-line policy, project-specific rules). ALWAYS call this once per conversation BEFORE writing or editing page content with create_page, insert_lines, or replace_lines. The guide reflects the server's current configuration and can change at any time — do not rely on remembered rules.`,
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: getToolName("create_page"),
          description: `Create a new page in Scrapbox project on ${SERVICE_LABEL}. Creates a new page with the specified title and optional body text. Returns the page creation URL without opening browser. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the new page",
              },
              body: {
                type: "string",
                description: bodyDescription,
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
              createActually: {
                type: "boolean",
                description: "Whether to actually create the page using WebSocket API. If true (default), creates the page immediately. If false, returns only the creation URL.",
              },
              format: {
                type: "string",
                enum: ["scrapbox", "markdown"],
                default: "scrapbox",
                description: "Content format. 'scrapbox' (default, STRONGLY recommended) writes native Cosense syntax as-is. 'markdown' converts Markdown to Scrapbox syntax but loses nuance. Always use 'scrapbox'.",
              },
            },
            required: ["title"],
          },
        },
        {
          name: getToolName("get_page_url"),
          description: `Generate URL for a page in Scrapbox project on ${SERVICE_LABEL}. Returns the direct URL to the specified page without opening it in browser. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the page",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["title"],
          },
        },
        {
          name: getToolName("get_page"),
          description: `Get a page from Scrapbox project on ${SERVICE_LABEL}. Returns page content and its linked pages. Page content includes title and description in plain text format. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["pageTitle"],
          },
        },
        {
          name: getToolName("list_pages"),
          description: `Browse and list pages from Scrapbox project on ${SERVICE_LABEL} with flexible sorting and pagination. Use this tool to discover pages by recency, popularity, or alphabetically. Returns page metadata and first 5 lines of content. Available sorting methods: updated (last update time), created (creation time), accessed (access time), linked (number of incoming links), views (view count), title (alphabetical). Different from search_pages which finds content by keywords. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              sort: {
                type: "string",
                enum: ["updated", "created", "accessed", "linked", "views", "title"],
                default: DEFAULT_LIST_SORT,
                description: `Sort method for the page list. Defaults to '${DEFAULT_LIST_SORT}'.`,
              },
              limit: {
                type: "number",
                minimum: 1,
                maximum: 1000,
                default: DEFAULT_LIST_LIMIT,
                description: `Maximum number of pages to return (1-1000). Defaults to ${DEFAULT_LIST_LIMIT}. Raise it only when you actually need more — each page includes its first 5 lines, so large values return very large responses.`,
              },
              skip: {
                type: "number",
                minimum: 0,
                description: "Number of pages to skip",
              },
              excludePinned: {
                type: "boolean",
                description: "Whether to exclude pinned pages from the results",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: [],
          },
        },
        {
          name: getToolName("search_pages"),
          description: `Search for content within pages in Scrapbox project on ${SERVICE_LABEL}. Use this tool to find pages containing specific keywords or phrases. Returns matching pages with highlighted search terms and content snippets. Limited to 100 results maximum. Supports basic search ("keyword"), multiple keywords ("word1 word2" for AND search), exclude words ("word1 -word2"), and exact phrases ("\\"exact phrase\\""). Different from list_pages which browses pages by metadata. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query string",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["query"],
          },
        },
        {
          name: getToolName("get_smart_context"),
          description: `Get smart context for a page on ${SERVICE_LABEL}. Returns the target page and its linked pages (1-hop or 2-hop) with full content in AI-optimized format. Useful for understanding the context and related knowledge around a specific topic. Requires COSENSE_SID authentication. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the page to get context for",
              },
              hopCount: {
                type: "number",
                enum: [1, 2],
                description: "Number of link hops to include. 1 (default) returns directly linked pages. 2 returns pages linked from linked pages (larger response).",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["title"],
          },
        },
        {
          name: getToolName("insert_lines"),
          description: `Insert text after a specified line in a Scrapbox page on ${SERVICE_LABEL}. If target line not found, text is appended to the end of the page. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page to modify",
              },
              targetLineText: {
                type: "string",
                description: "Exact text of the line — or a newline-separated block of consecutive lines — after which to insert. If multiple locations match, inserts after the first unless occurrence is specified. If not found, text is appended to the end of the page.",
              },
              occurrence: {
                type: "number",
                minimum: 1,
                description: "1-based index to select among multiple matches, in page order.",
              },
              text: {
                type: "string",
                description: `Text to insert in Scrapbox/Cosense syntax. ${insertTextDescription}`,
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
              format: {
                type: "string",
                enum: ["scrapbox", "markdown"],
                default: "scrapbox",
                description: "Content format. 'scrapbox' (default, STRONGLY recommended) writes native Cosense syntax as-is. Always use 'scrapbox'.",
              },
            },
            required: ["pageTitle", "targetLineText", "text"],
          },
        },
        {
          name: getToolName("replace_lines"),
          description: `Replace a specific line in a Scrapbox page on ${SERVICE_LABEL}. The target line must match exactly and uniquely (single match only). Use get_page first to see current page content. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page to modify",
              },
              targetLineText: {
                type: "string",
                description: "Exact text of the line to replace. May contain newlines to match a block of consecutive lines exactly (the whole block is replaced). Must match exactly one location — if the same line/block appears multiple times, pass occurrence or extend the block with adjacent lines. Use get_page to verify the exact text before calling.",
              },
              occurrence: {
                type: "number",
                minimum: 1,
                description: "1-based index to select among multiple matches (in page order). Required when targetLineText matches more than one location.",
              },
              newText: {
                type: "string",
                description: `Replacement text in Scrapbox/Cosense syntax. ${replaceTextDescription}`,
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
              format: {
                type: "string",
                enum: ["scrapbox", "markdown"],
                default: "scrapbox",
                description: "Content format. 'scrapbox' (default, STRONGLY recommended) writes native Cosense syntax as-is. Always use 'scrapbox'.",
              },
            },
            required: ["pageTitle", "targetLineText", "newText"],
          },
        },
        {
          name: getToolName("rename_page"),
          description: `Rename a Scrapbox page on ${SERVICE_LABEL} by rewriting its title line. Fails if the page does not exist or a page with the new title already exists. IMPORTANT: links from other pages to the old title are NOT updated automatically — the response lists pages that may need updating. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Current title of the page to rename",
              },
              newTitle: {
                type: "string",
                description: "New title for the page",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["pageTitle", "newTitle"],
          },
        },
        // delete_page / rewrite_page は、その接続に許しているときだけ登録する。
        // ページ全体を壊せる操作なので、既定では tools/list にも出さない
        // （公開しているエンドポイントでは「呼べる形で置いておかない」のが一番効く）。
        // 実行時にもゲートしているが、見せない側を先に効かせる — 見えていると
        // クライアントは「使える」と判断して提案してくるし、断り方も説明しづらい。
        ...(session.enableDelete ? [{
          name: getToolName("delete_page"),
          description: `Delete a page in Scrapbox project on ${SERVICE_LABEL}. Empties every line of the target page via the WebSocket patch API; Cosense automatically removes a page once all of its lines are empty. There is no undo — pass dryRun to preview what would be removed first. Errors if the page does not exist. Requires COSENSE_SID. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page to delete",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
              dryRun: {
                type: "boolean",
                description: "If true, report the number of lines and the first few lines that would be removed without deleting anything. Defaults to false.",
              },
            },
            required: ["pageTitle"],
          },
        }, {
          name: getToolName("rewrite_page"),
          description: `Replace the entire content of a Scrapbox page on ${SERVICE_LABEL} with new content (the page title is preserved as the first line). This is a destructive, whole-page operation with no undo. Prefer insert_lines / replace_lines for targeted edits. Errors if the page does not exist, and rejects empty content (use delete_page to remove a page). Pass dryRun to preview before/after without changing anything. Requires COSENSE_SID. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page to rewrite",
              },
              body: {
                type: "string",
                description: bodyDescription,
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
              format: {
                type: "string",
                enum: ["scrapbox", "markdown"],
                default: "scrapbox",
                description: "Content format. 'scrapbox' (default, STRONGLY recommended) writes native Cosense syntax as-is. Always use 'scrapbox'.",
              },
              dryRun: {
                type: "boolean",
                description: "If true, report the current and new line counts and previews without changing anything. Defaults to false.",
              },
            },
            required: ["pageTitle", "body"],
          },
        }] : []),
        {
          name: getToolName("delete_lines"),
          description: `Delete a specific line from a Scrapbox page on ${SERVICE_LABEL}. The target line must match exactly and uniquely (single match only). Use get_page first to see current page content. Uses ${session.projectName} project as default if projectName is not specified.`,
          inputSchema: {
            type: "object",
            properties: {
              pageTitle: {
                type: "string",
                description: "Title of the page to modify",
              },
              targetLineText: {
                type: "string",
                description: "Exact text of the line to delete. May contain newlines to match a block of consecutive lines exactly (the whole block is deleted). Must match exactly one location — if the same line/block appears multiple times, pass occurrence or extend the block with adjacent lines. Use get_page to verify the exact text before calling.",
              },
              occurrence: {
                type: "number",
                minimum: 1,
                description: "1-based index to select among multiple matches (in page order). Required when targetLineText matches more than one location.",
              },
              projectName: {
                type: "string",
                description: projectNameDescription,
              },
            },
            required: ["pageTitle", "targetLineText"],
          },
        },
      ];


    return { tools };
  });

  // ルートのセットアップ
  setupRoutes(server, {
    projectName: session.projectName,
    cosenseSid: session.cosenseSid,
    toolSuffix: TOOL_SUFFIX,
    allowedProjects: session.allowedProjects,
    enableDelete: session.enableDelete,
  });

  return server;
}

// Transport選択
const transport = process.env.TRANSPORT;

if (transport === 'http') {
  const { startHttpServer } = await import('./http-server.js');
  const { resolveOAuthConfig } = await import('./auth/config.js');
  const port = parseInt(process.env.PORT || '3000', 10);
  const authToken = process.env.MCP_AUTH_TOKEN;
  const oauth = resolveOAuthConfig();
  const trustProxy = process.env.MCP_TRUST_PROXY;
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // 管理画面は MCP とは別のポート。Cloudflare Tunnel が通すのは MCP 側だけなので、
  // ここはインターネットから到達できず、LAN と Tailscale からしか開けない。
  const adminPort = process.env.MCP_ADMIN_PORT ? parseInt(process.env.MCP_ADMIN_PORT, 10) : undefined;
  const onAuthWiring = adminPort && oauth
    ? async (wiring: { store: import('./auth/store.js').OAuthStore }) => {
        const { startAdminServer } = await import('./admin-server.js');
        startAdminServer(adminPort, {
          config: oauth,
          store: wiring.store,
          ...(trustProxy ? { trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy } : {}),
        });
      }
    : undefined;

  startHttpServer((authInfo) => createServer(resolveSessionConfig(authInfo, oauth?.users, sessionDefaults())), {
    port,
    ...(authToken ? { authToken } : {}),
    ...(oauth ? { oauth } : {}),
    allowUnauthenticated: process.env.MCP_ALLOW_UNAUTHENTICATED === 'true',
    ...(trustProxy ? { trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy } : {}),
    ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    ...(onAuthWiring ? { onAuthWiring } : {}),
  });
} else {
  // デフォルト: stdio transport
  const server = createServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
