import { patch } from '@cosense/std/websocket';
import type { BaseLine } from '@cosense/types/rest';
import { convertMarkdownToScrapbox } from '../../utils/markdown-converter.js';
import { formatError, stringifyError } from '../../utils/format.js';
import { selectBlockMatch, formatMatchStarts, AMBIGUITY_HINT, type BlockMatch } from '../../utils/line-match.js';

export interface ReplaceLinesParams {
  pageTitle: string;
  targetLineText: string;
  newText: string;
  occurrence?: number | undefined;
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

    let match: BlockMatch | undefined;
    const result = await patch(projectName, params.pageTitle, (lines: BaseLine[]) => {
      match = selectBlockMatch(lines, params.targetLineText, params.occurrence);

      if (match.selected === undefined) {
        return undefined; // abort
      }

      const newLines = convertedText.split('\n').map(text => ({ text }));

      return [
        ...lines.slice(0, match.selected),
        ...newLines,
        ...lines.slice(match.selected + match.targetLines.length)
      ];
    }, {
      sid: cosenseSid
    });

    // Handle match errors (patch was aborted with undefined)
    const errorContext = {
      Operation: 'replace_lines',
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

    const targetLinesCount = match?.targetLines.length ?? 1;
    const replacedLinesCount = convertedText.split('\n').length;

    if (params.compact) {
      return {
        content: [{
          type: "text",
          text: `replaced: ${targetLinesCount} line(s) → ${replacedLinesCount} line(s) in ${params.pageTitle}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: [
          'Successfully replaced line(s) in page',
          `Operation: replace_lines`,
          `Project: ${projectName}`,
          `Page: ${params.pageTitle}`,
          `Target block: "${params.targetLineText}" (${targetLinesCount} line(s))`,
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
