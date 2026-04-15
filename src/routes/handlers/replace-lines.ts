import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { convertMarkdownToScrapbox } from '../../utils/markdown-converter.js';
import { formatError, stringifyError } from '../../utils/format.js';

export interface ReplaceLinesParams {
  pageTitle: string;
  targetLineText: string;
  newText: string;
  projectName?: string | undefined;
  format?: "markdown" | "scrapbox" | undefined;
  compact?: boolean | undefined;
}

export async function handleReplaceLines(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: ReplaceLinesParams
) {
  try {
    const projectName = params.projectName || defaultProjectName;

    if (!cosenseSid) {
      return formatError('Authentication required: COSENSE_SID is needed for page editing', {
        Operation: 'replace_lines',
        Project: projectName,
        Page: params.pageTitle,
        Timestamp: new Date().toISOString(),
      }, params.compact);
    }

    const convertNumberedLists = process.env.COSENSE_CONVERT_NUMBERED_LISTS === 'true';

    let convertedText: string;
    if (params.format === 'markdown') {
      convertedText = await convertMarkdownToScrapbox(params.newText, { convertNumberedLists });
    } else {
      convertedText = params.newText;
    }

    let matchCount = 0;
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      // Count exact matches
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
      const newLines = convertedText.split('\n').map(text => ({ text }));

      return [
        ...lines.slice(0, targetIndex),
        ...newLines,
        ...lines.slice(targetIndex + 1)
      ];
    }, {
      sid: cosenseSid
    });

    // Handle match errors (patch was aborted with undefined)
    if (matchCount === 0) {
      return formatError(
        'Target line not found. Please get the latest page content and verify the exact line text.',
        {
          Operation: 'replace_lines',
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
          Operation: 'replace_lines',
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

    const replacedLinesCount = convertedText.split('\n').length;

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `replaced: 1 line → ${replacedLinesCount} line(s) in ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully replaced line in page',
          `Operation: replace_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Target line: "${params.targetLineText}"`,
          `Replacement lines: ${replacedLinesCount}`,
          `Timestamp: ${new Date().toISOString()}`
        ].join('\n')
      }]
    };

  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'replace_lines',
        Project: params.projectName || defaultProjectName,
        Page: params.pageTitle,
        'Target line': `"${params.targetLineText}"`,
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
