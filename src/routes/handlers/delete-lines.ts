import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { formatError, stringifyError } from '../../utils/format.js';
import { selectBlockMatch, formatMatchStarts, AMBIGUITY_HINT, type BlockMatch } from '../../utils/line-match.js';

export interface DeleteLinesParams {
  pageTitle: string;
  targetLineText: string;
  occurrence?: number | undefined;
  projectName?: string | undefined;
  compact?: boolean | undefined;
}

export async function handleDeleteLines(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: DeleteLinesParams
) {
  try {
    const projectName = params.projectName || defaultProjectName;

    if (!cosenseSid) {
      return formatError('Authentication required: COSENSE_SID is needed for page editing', {
        Operation: 'delete_lines',
        Project: projectName,
        Page: params.pageTitle,
        Timestamp: new Date().toISOString(),
      }, params.compact);
    }

    let match: BlockMatch | undefined;
    let wouldDeleteTitle = false;
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      // patch がコンフリクトでリトライした場合に前回の結果が残らないようリセットする
      wouldDeleteTitle = false;
      match = selectBlockMatch(lines, params.targetLineText, params.occurrence);

      if (match.selected === undefined) {
        return undefined; // abort
      }

      // 先頭行はタイトル。削除するとページのリネーム（または全行削除による消滅）になるため拒否する。
      // delete_page がゲートの内側にある以上、ゲートの外側にある delete_lines から
      // 同じことができてはならない。認証の有無とは無関係に、行編集ツールが
      // ページのリネームや消滅を起こすこと自体が驚きなので、常に拒否する。
      if (match.selected === 0) {
        wouldDeleteTitle = true;
        return undefined; // abort
      }

      return [
        ...lines.slice(0, match.selected),
        ...lines.slice(match.selected + match.targetLines.length)
      ];
    }, {
      sid: cosenseSid
    });

    const errorContext = {
      Operation: 'delete_lines',
      Project: projectName,
      Page: params.pageTitle,
      'Target line': `"${params.targetLineText}"`,
      Timestamp: new Date().toISOString(),
    };

    if (match?.selectionError === 'not_found') {
      return formatError(
        'Target line not found. Please get the latest page content and verify the exact line text.',
        errorContext,
        params.compact
      );
    }
    if (match?.selectionError === 'ambiguous') {
      return formatError(
        `Multiple locations matched (${match.matchStarts.length} matches, starting at lines ${formatMatchStarts(match.matchStarts)}; line 1 = title). ${AMBIGUITY_HINT}`,
        { ...errorContext, 'Match count': String(match.matchStarts.length) },
        params.compact
      );
    }
    if (wouldDeleteTitle) {
      return formatError(
        'Refusing to delete the title line (line 1). Deleting it would rename or remove the page. Use rename_page to change the title.',
        errorContext,
        params.compact
      );
    }
    if (match?.selectionError === 'occurrence_out_of_range') {
      return formatError(
        `occurrence=${params.occurrence} is out of range: only ${match.matchStarts.length} match(es) found (starting at lines ${formatMatchStarts(match.matchStarts)}; line 1 = title).`,
        { ...errorContext, 'Match count': String(match.matchStarts.length) },
        params.compact
      );
    }

    if (!result.ok) {
      throw new Error(`WebSocket patch failed: ${stringifyError(result.err)}`);
    }

    const deletedCount = match?.targetLines.length ?? 1;

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `deleted: ${deletedCount} line(s) from ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully deleted line(s) from page',
          `Operation: delete_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Deleted lines: ${deletedCount}`,
          `Deleted block: "${params.targetLineText}"`,
          `Timestamp: ${new Date().toISOString()}`
        ].join('\n')
      }]
    };

  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'delete_lines',
        Project: params.projectName || defaultProjectName,
        Page: params.pageTitle,
        'Target line': `"${params.targetLineText}"`,
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
