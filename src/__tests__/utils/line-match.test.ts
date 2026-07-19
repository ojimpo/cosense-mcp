import { selectBlockMatch, formatMatchStarts } from '@/utils/line-match.js';

const lines = (...texts: string[]) => texts.map(text => ({ text }));

describe('selectBlockMatch', () => {
  test('単一行のユニークマッチ', () => {
    const result = selectBlockMatch(lines('title', 'a', 'b'), 'a');
    expect(result.selected).toBe(1);
    expect(result.selectionError).toBeUndefined();
  });

  test('マッチなしは not_found', () => {
    const result = selectBlockMatch(lines('title', 'a'), 'x');
    expect(result.selected).toBeUndefined();
    expect(result.selectionError).toBe('not_found');
  });

  test('複数マッチ・occurrence未指定は ambiguous', () => {
    const result = selectBlockMatch(lines('title', 'dup', 'x', 'dup'), 'dup');
    expect(result.selectionError).toBe('ambiguous');
    expect(result.matchStarts).toEqual([1, 3]);
  });

  test('occurrence でN番目を選択', () => {
    const result = selectBlockMatch(lines('title', 'dup', 'x', 'dup'), 'dup', 2);
    expect(result.selected).toBe(3);
  });

  test('occurrence はユニークマッチでも使える', () => {
    const result = selectBlockMatch(lines('title', 'a'), 'a', 1);
    expect(result.selected).toBe(1);
  });

  test('occurrence 範囲外は occurrence_out_of_range', () => {
    expect(selectBlockMatch(lines('title', 'a'), 'a', 2).selectionError).toBe('occurrence_out_of_range');
    expect(selectBlockMatch(lines('title', 'a'), 'a', 0).selectionError).toBe('occurrence_out_of_range');
    expect(selectBlockMatch(lines('title', 'a'), 'a', 1.5).selectionError).toBe('occurrence_out_of_range');
  });

  test('複数行ブロックの連続完全一致', () => {
    const result = selectBlockMatch(lines('title', 'a', 'b', 'c', 'd'), 'b\nc');
    expect(result.selected).toBe(2);
    expect(result.targetLines).toEqual(['b', 'c']);
  });

  test('ブロックは連続していなければマッチしない', () => {
    const result = selectBlockMatch(lines('title', 'a', 'x', 'b'), 'a\nb');
    expect(result.selectionError).toBe('not_found');
  });

  test('重複ブロックも検出して ambiguous', () => {
    const result = selectBlockMatch(lines('t', 'a', 'b', 'z', 'a', 'b'), 'a\nb');
    expect(result.selectionError).toBe('ambiguous');
    expect(result.matchStarts).toEqual([1, 4]);
  });

  test('部分一致はマッチしない（行単位の完全一致のみ）', () => {
    const result = selectBlockMatch(lines('title', 'my TODO list'), 'TODO');
    expect(result.selectionError).toBe('not_found');
  });
});

describe('formatMatchStarts', () => {
  test('1-based の行番号として整形', () => {
    expect(formatMatchStarts([1, 3])).toBe('2, 4');
  });
});
