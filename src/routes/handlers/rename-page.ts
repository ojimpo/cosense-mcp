import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { getPage, createPageUrl } from '../../cosense.js';
import { formatError, stringifyError } from '../../utils/format.js';

export interface RenamePageParams {
  pageTitle: string;
  newTitle: string;
  projectName?: string | undefined;
  compact?: boolean | undefined;
}

export async function handleRenamePage(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: RenamePageParams
) {
  try {
    const projectName = params.projectName || defaultProjectName;
    const errorContext = {
      Operation: 'rename_page',
      Project: projectName,
      Page: params.pageTitle,
      'New title': params.newTitle,
      Timestamp: new Date().toISOString(),
    };

    if (!cosenseSid) {
      return formatError('Authentication required: COSENSE_SID is needed for page editing', errorContext, params.compact);
    }

    if (!params.newTitle.trim()) {
      return formatError('New title must not be empty.', errorContext, params.compact);
    }

    if (params.newTitle === params.pageTitle) {
      return formatError('New title is identical to the current title.', errorContext, params.compact);
    }

    // リネーム元の存在チェック（patchは存在しないページを新規作成してしまうため必須）
    const sourcePage = await getPage(projectName, params.pageTitle, cosenseSid);
    if (!sourcePage || !sourcePage.persistent) {
      return formatError(`Page not found: ${params.pageTitle}`, errorContext, params.compact);
    }

    // リネーム先の存在チェック（既存ページへのリネームは内容が衝突するため拒否）
    const destPage = await getPage(projectName, params.newTitle, cosenseSid);
    if (destPage && destPage.persistent) {
      return formatError(
        `A page titled "${params.newTitle}" already exists. Renaming onto an existing page is not allowed — choose another title or merge the contents manually.`,
        errorContext,
        params.compact
      );
    }

    // タイトル行（1行目）だけを書き換える
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      return [{ text: params.newTitle }, ...lines.slice(1)];
    }, {
      sid: cosenseSid
    });

    if (!result.ok) {
      throw new Error(`WebSocket patch failed: ${stringifyError(result.err)}`);
    }

    // バックリンク候補: 1-hop関連ページのうち、このページから外向きにリンクしていないもの
    // （＝旧タイトルへリンクしている可能性が高いページ）。Scrapboxはリネームで
    // 他ページ内の [旧タイトル] を書き換えないため、呼び出し側に更新を促す。
    const outgoing = new Set(sourcePage.links.map(l => l.toLowerCase()));
    const backlinkCandidates = sourcePage.relatedPages.links1hop
      .map(p => p.title)
      .filter(title => !outgoing.has(title.toLowerCase()) && title !== params.pageTitle);

    const url = createPageUrl(projectName, params.newTitle);

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `renamed: ${params.pageTitle} → ${params.newTitle} (${backlinkCandidates.length} possible backlink page(s) NOT updated)`
        }]
      };
    }

    const backlinkNote = backlinkCandidates.length > 0
      ? [
          `WARNING: links are NOT updated automatically. ${backlinkCandidates.length} page(s) may still link to the old title "${params.pageTitle}":`,
          ...backlinkCandidates.map(t => `- ${t}`),
          `Use replace_lines on those pages (or search_pages "${params.pageTitle}") to update references.`,
        ]
      : [
          `Note: links are NOT updated automatically. Use search_pages "${params.pageTitle}" to check for remaining references.`,
        ];

    return {
      content: [{
        type: "text",
        text: [
          'Successfully renamed page',
          `Operation: rename_page`,
          `Project: ${projectName}`,
          `Old title: ${params.pageTitle}`,
          `New title: ${params.newTitle}`,
          `URL: ${url}`,
          ...backlinkNote,
          `Timestamp: ${new Date().toISOString()}`
        ].join('\n')
      }]
    };

  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'rename_page',
        Project: params.projectName || defaultProjectName,
        Page: params.pageTitle,
        'New title': params.newTitle,
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
