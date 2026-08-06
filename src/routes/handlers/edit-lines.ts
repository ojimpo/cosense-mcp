import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { convertMarkdownToScrapbox } from '../../utils/markdown-converter.js';
import { formatError, stringifyError } from '../../utils/format.js';

export interface EditLinesParams {
  pageTitle: string;
  targetLineText: string;
  newText: string;
  projectName?: string | undefined;
  format?: "markdown" | "scrapbox" | undefined;
  matchAll?: boolean | undefined;
  compact?: boolean | undefined;
}

export async function handleEditLines(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: EditLinesParams
) {
  const projectName = params.projectName || defaultProjectName;

  try {
    if (!cosenseSid) {
      return formatError('Authentication required: COSENSE_SID is needed for editing pages', {
        Operation: 'edit_lines',
        Project: projectName,
        Page: params.pageTitle,
        Timestamp: new Date().toISOString(),
      }, params.compact);
    }

    const convertNumberedLists = process.env.COSENSE_CONVERT_NUMBERED_LISTS === 'true';

    let convertedText: string;
    if (params.format === 'scrapbox') {
      convertedText = params.newText;
    } else {
      convertedText = await convertMarkdownToScrapbox(params.newText, { convertNumberedLists });
    }

    const replacementLines = convertedText.split('\n').map(text => ({ text }));
    let replacedCount = 0;

    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      // patchがコンフリクトでリトライした場合に前回の結果が残らないようリセットする
      replacedCount = 0;
      const matchedIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.text === params.targetLineText) {
          matchedIndices.push(i);
          if (!params.matchAll) break;
        }
      }

      if (matchedIndices.length === 0) {
        return lines;
      }

      // Replace matches from the back so indices on the left stay valid.
      let next = lines.slice() as Array<BaseLine | { text: string }>;
      for (let i = matchedIndices.length - 1; i >= 0; i--) {
        const idx = matchedIndices[i]!;
        next = [
          ...next.slice(0, idx),
          ...replacementLines,
          ...next.slice(idx + 1),
        ];
      }
      replacedCount = matchedIndices.length;
      return next as BaseLine[];
    }, {
      sid: cosenseSid,
    });

    if (!result.ok) {
      throw new Error(`WebSocket patch failed: ${stringifyError(result.err)}`);
    }

    if (replacedCount === 0) {
      return formatError(`Target line not found: "${params.targetLineText}"`, {
        Operation: 'edit_lines',
        Project: projectName,
        Page: params.pageTitle,
        Timestamp: new Date().toISOString(),
      }, params.compact);
    }

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `edited: ${replacedCount} line(s) in ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully edited line(s)',
          `Operation: edit_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Target line: "${params.targetLineText}"`,
          `Matches replaced: ${replacedCount}`,
          `Replacement lines: ${replacementLines.length}`,
          `Timestamp: ${new Date().toISOString()}`
        ].join('\n')
      }]
    };

  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'edit_lines',
        Project: projectName,
        Page: params.pageTitle,
        'Target line': `"${params.targetLineText}"`,
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
