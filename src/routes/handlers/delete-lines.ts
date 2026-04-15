import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { formatError, stringifyError } from '../../utils/format.js';

export interface DeleteLinesParams {
  pageTitle: string;
  targetLineText: string;
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

    let matchCount = 0;
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      const matchingIndices = lines
        .map((line, index) => line.text === params.targetLineText ? index : -1)
        .filter(index => index >= 0);

      matchCount = matchingIndices.length;

      if (matchCount === 0) {
        return undefined; // abort
      }
      if (matchCount > 1) {
        return undefined; // abort
      }

      const targetIndex = matchingIndices[0]!;
      return [
        ...lines.slice(0, targetIndex),
        ...lines.slice(targetIndex + 1)
      ];
    }, {
      sid: cosenseSid
    });

    if (matchCount === 0) {
      return formatError(
        'Target line not found. Please get the latest page content and verify the exact line text.',
        {
          Operation: 'delete_lines',
          Project: projectName,
          Page: params.pageTitle,
          'Target line': `"${params.targetLineText}"`,
          Timestamp: new Date().toISOString(),
        },
        params.compact
      );
    }
    if (matchCount > 1) {
      return formatError(
        `Multiple lines matched (${matchCount} matches). Please specify a more unique line text.`,
        {
          Operation: 'delete_lines',
          Project: projectName,
          Page: params.pageTitle,
          'Target line': `"${params.targetLineText}"`,
          'Match count': String(matchCount),
          Timestamp: new Date().toISOString(),
        },
        params.compact
      );
    }

    if (!result.ok) {
      throw new Error(`WebSocket patch failed: ${stringifyError(result.err)}`);
    }

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `deleted: 1 line from ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully deleted line from page',
          `Operation: delete_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Deleted line: "${params.targetLineText}"`,
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
