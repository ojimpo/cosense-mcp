import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleListPages } from './handlers/list-pages.js';
import { handleGetPage } from './handlers/get-page.js';
import { handleSearchPages } from './handlers/search-pages.js';
import { handleCreatePage } from './handlers/create-page.js';
import { handleGetPageUrl } from './handlers/get-page-url.js';
import { handleInsertLines } from './handlers/insert-lines.js';
import { handleReplaceLines } from './handlers/replace-lines.js';
import { handleDeleteLines } from './handlers/delete-lines.js';
import { handleGetSmartContext } from './handlers/get-smart-context.js';
import { handleGetNotationGuide } from './handlers/get-notation-guide.js';
import { handleRenamePage } from './handlers/rename-page.js';
import { handleDeletePage } from './handlers/delete-page.js';
import { handleRewritePage } from './handlers/rewrite-page.js';
import { checkProjectAllowed } from '../utils/project.js';
import { formatError } from '../utils/format.js';

// ツール名正規化ヘルパー
function normalizeToolName(toolName: string, toolSuffix?: string): string {
  if (!toolSuffix) return toolName;
  
  const suffix = `_${toolSuffix}`;
  return toolName.endsWith(suffix) ? toolName.slice(0, -suffix.length) : toolName;
}

export function setupRoutes(
  server: Server,
  config: {
    projectName: string;
    cosenseSid?: string | undefined;
    toolSuffix?: string | undefined;
    /** 触れるプロジェクト。未指定なら無制限（従来どおり）。 */
    allowedProjects?: string[] | undefined;
    /** 破壊的ツールを許すか。未指定なら環境変数に従う。 */
    enableDelete?: boolean | undefined;
  }
) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { projectName, cosenseSid, toolSuffix, allowedProjects, enableDelete } = config;
    const normalizedToolName = normalizeToolName(request.params.name, toolSuffix);

    // 操作対象プロジェクトの制限は、ツールごとではなくここで一度だけ見る。
    // 各ハンドラに同じチェックを撒くと、ツールを足した人が忘れた時点で穴が開く。
    // 上書きが入ってくるのはこの境界なので、ここで止めれば全ツールが漏れなく守られる。
    const requestedProject = request.params.arguments?.projectName;
    if (typeof requestedProject === 'string') {
      const denied = checkProjectAllowed(requestedProject, projectName, allowedProjects);
      if (denied) {
        return formatError(denied, {
          Operation: normalizedToolName,
          Project: requestedProject,
          Timestamp: new Date().toISOString(),
        });
      }
    }

    switch (normalizedToolName) {
      case "list_pages":
        return handleListPages(
          projectName,
          cosenseSid,
          {
            ...request.params.arguments || {},
            projectName: request.params.arguments?.projectName as string | undefined
          }
        );

      case "get_page":
        return handleGetPage(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            projectName: request.params.arguments?.projectName as string | undefined
          }
        );

      case "search_pages":
        return handleSearchPages(
          projectName,
          cosenseSid,
          {
            query: String(request.params.arguments?.query),
            projectName: request.params.arguments?.projectName as string | undefined
          }
        );

      case "create_page":
        return handleCreatePage(
          projectName,
          cosenseSid,
          {
            title: String(request.params.arguments?.title),
            body: (request.params.arguments?.body as string | undefined) ?? undefined,
            projectName: request.params.arguments?.projectName as string | undefined,
            createActually: (request.params.arguments?.createActually as boolean | undefined) ?? undefined,
            format: (request.params.arguments?.format as "markdown" | "scrapbox" | undefined) ?? undefined
          }
        );

      case "get_page_url":
        return handleGetPageUrl(
          projectName,
          cosenseSid,
          {
            title: String(request.params.arguments?.title),
            projectName: request.params.arguments?.projectName as string | undefined
          }
        );

      case "insert_lines":
        return handleInsertLines(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            targetLineText: String(request.params.arguments?.targetLineText),
            text: String(request.params.arguments?.text),
            occurrence: request.params.arguments?.occurrence != null
              ? Number(request.params.arguments.occurrence)
              : undefined,
            projectName: request.params.arguments?.projectName as string | undefined,
            format: (request.params.arguments?.format as "markdown" | "scrapbox" | undefined) ?? undefined
          }
        );

      case "replace_lines":
        return handleReplaceLines(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            targetLineText: String(request.params.arguments?.targetLineText),
            newText: String(request.params.arguments?.newText),
            occurrence: request.params.arguments?.occurrence != null
              ? Number(request.params.arguments.occurrence)
              : undefined,
            projectName: request.params.arguments?.projectName as string | undefined,
            format: (request.params.arguments?.format as "markdown" | "scrapbox" | undefined) ?? undefined
          }
        );

      case "delete_lines":
        return handleDeleteLines(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            targetLineText: String(request.params.arguments?.targetLineText),
            occurrence: request.params.arguments?.occurrence != null
              ? Number(request.params.arguments.occurrence)
              : undefined,
            projectName: request.params.arguments?.projectName as string | undefined,
          }
        );

      case "delete_page":
        return handleDeletePage(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            projectName: request.params.arguments?.projectName as string | undefined,
            dryRun: request.params.arguments?.dryRun === true,
            ...(enableDelete !== undefined ? { enableDelete } : {}),
          }
        );

      case "rewrite_page":
        return handleRewritePage(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            body: String(request.params.arguments?.body ?? ''),
            projectName: request.params.arguments?.projectName as string | undefined,
            format: (request.params.arguments?.format as "markdown" | "scrapbox" | undefined) ?? undefined,
            dryRun: request.params.arguments?.dryRun === true,
            ...(enableDelete !== undefined ? { enableDelete } : {}),
          }
        );

      case "rename_page":
        return handleRenamePage(
          projectName,
          cosenseSid,
          {
            pageTitle: String(request.params.arguments?.pageTitle),
            newTitle: String(request.params.arguments?.newTitle),
            projectName: request.params.arguments?.projectName as string | undefined,
          }
        );

      case "get_notation_guide":
        return handleGetNotationGuide(projectName, cosenseSid, {
          projectName: request.params.arguments?.projectName as string | undefined,
        });

      case "get_smart_context":
        return handleGetSmartContext(
          projectName,
          cosenseSid,
          {
            title: String(request.params.arguments?.title),
            hopCount: request.params.arguments?.hopCount != null
              ? Number(request.params.arguments.hopCount)
              : undefined,
            projectName: request.params.arguments?.projectName as string | undefined,
            compact: request.params.arguments?.compact as boolean | undefined,
          }
        );

      default:
        return {
          content: [{
            type: "text",
            text: [
              'Error details:',
              'Message: Unknown tool requested',
              `Tool: ${request.params.name}`,
              `Timestamp: ${new Date().toISOString()}`
            ].join('\n')
          }],
          isError: true
        };
    }
  });
}
