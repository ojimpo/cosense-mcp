/**
 * Block matching for line-edit tools (insert/replace/delete).
 *
 * `targetLineText` may contain newlines: the split lines are matched as a
 * consecutive block, each line by exact text comparison. `occurrence`
 * (1-based, in page order) selects among multiple matches — this is the
 * escape hatch for pages where the same line/block appears more than once.
 */

export interface BlockMatch {
  /** Lines of the target block (targetLineText split by \n) */
  targetLines: string[];
  /** 0-based start indices of every match, in page order */
  matchStarts: number[];
  /** 0-based start index of the selected match (set when selection succeeded) */
  selected?: number;
  selectionError?: 'not_found' | 'ambiguous' | 'occurrence_out_of_range';
}

export function selectBlockMatch(
  lines: { text: string }[],
  targetLineText: string,
  occurrence?: number,
): BlockMatch {
  const targetLines = targetLineText.split('\n');

  const matchStarts: number[] = [];
  for (let i = 0; i + targetLines.length <= lines.length; i++) {
    if (targetLines.every((t, j) => lines[i + j]!.text === t)) {
      matchStarts.push(i);
    }
  }

  const result: BlockMatch = { targetLines, matchStarts };

  if (matchStarts.length === 0) {
    result.selectionError = 'not_found';
    return result;
  }

  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matchStarts.length) {
      result.selectionError = 'occurrence_out_of_range';
      return result;
    }
    result.selected = matchStarts[occurrence - 1]!;
    return result;
  }

  if (matchStarts.length > 1) {
    result.selectionError = 'ambiguous';
    return result;
  }

  result.selected = matchStarts[0]!;
  return result;
}

/** Human-readable 1-based line numbers of match starts (line 1 = title line) */
export function formatMatchStarts(matchStarts: number[]): string {
  return matchStarts.map(i => String(i + 1)).join(', ');
}

/** Shared guidance appended to ambiguity errors */
export const AMBIGUITY_HINT =
  'Pass occurrence=N (1-based, in page order) to select one, or extend targetLineText with adjacent lines (newline-separated) to make the block unique.';
