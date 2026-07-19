import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { convertMarkdownToScrapbox } from '../../utils/markdown-converter.js';
import { formatError, stringifyError } from '../../utils/format.js';
import { selectBlockMatch, formatMatchStarts, type BlockMatch } from '../../utils/line-match.js';

export interface InsertLinesParams {
  pageTitle: string;
  targetLineText: string;
  text: string;
  occurrence?: number | undefined;
  projectName?: string | undefined;
  format?: "markdown" | "scrapbox" | undefined;
  compact?: boolean | undefined;
}

export async function handleInsertLines(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: InsertLinesParams
) {
  try {
    const projectName = params.projectName || defaultProjectName;

    if (!cosenseSid) {
      return formatError('Authentication required: COSENSE_SID is needed for page editing', {
        Operation: 'insert_lines',
        Project: projectName,
        Page: params.pageTitle,
        Timestamp: new Date().toISOString(),
      }, params.compact);
    }

    // 環境変数から設定を取得
    const convertNumberedLists = process.env.COSENSE_CONVERT_NUMBERED_LISTS === 'true';

    let convertedText: string;
    if (params.format === 'markdown') {
      convertedText = await convertMarkdownToScrapbox(params.text, { convertNumberedLists });
    } else {
      // Default: scrapbox — pass through as-is
      convertedText = params.text;
    }

    // WebSocket経由でページを更新
    // 互換性維持: occurrence未指定で複数マッチした場合は従来通り最初のマッチ、
    // 見つからない場合は末尾追記。occurrence指定時のみ範囲外をエラーにする。
    let match: BlockMatch | undefined;
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      match = selectBlockMatch(lines, params.targetLineText, params.occurrence);

      if (match.selectionError === 'occurrence_out_of_range') {
        return undefined; // abort
      }

      const blockStart = match.selected ?? match.matchStarts[0];
      const insertIndex = blockStart !== undefined
        ? blockStart + match.targetLines.length
        : lines.length;

      // 新しいテキストを行に分割
      const newLines = convertedText.split('\n').map(text => ({ text }));

      // 行を再構築
      return [
        ...lines.slice(0, insertIndex),
        ...newLines,
        ...lines.slice(insertIndex)
      ];
    }, {
      sid: cosenseSid
    });

    if (match?.selectionError === 'occurrence_out_of_range') {
      return formatError(
        `occurrence=${params.occurrence} is out of range: only ${match.matchStarts.length} match(es) found (starting at lines ${formatMatchStarts(match.matchStarts)}; line 1 = title).`,
        {
          Operation: 'insert_lines',
          Project: projectName,
          Page: params.pageTitle,
          'Target line': `"${params.targetLineText}"`,
          'Match count': String(match.matchStarts.length),
          Timestamp: new Date().toISOString(),
        },
        params.compact
      );
    }

    // patchのResult型を正しく判定
    if (!result.ok) {
      throw new Error(`WebSocket patch failed: ${stringifyError(result.err)}`);
    }

    // 成功時のレスポンス
    const insertedLinesCount = convertedText.split('\n').length;
    const matchCount = match?.matchStarts.length ?? 0;
    const targetLineFound = matchCount === 0
      ? "not found (appended to end)"
      : matchCount === 1 || params.occurrence !== undefined
        ? "found"
        : `found ${matchCount} matches — inserted after the first (pass occurrence=N to target another)`;

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `inserted: ${insertedLinesCount} lines into ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully inserted lines into page',
          `Operation: insert_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Target line: "${params.targetLineText}" (${targetLineFound})`,
          `Inserted lines: ${insertedLinesCount}`,
          `Timestamp: ${new Date().toISOString()}`
        ].join('\n')
      }]
    };

  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'insert_lines',
        Project: params.projectName || defaultProjectName,
        Page: params.pageTitle,
        'Target line': `"${params.targetLineText}"`,
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
