import { type ListPagesResponse } from "../../cosense.js";
import { listPages, listPagesWithSort } from "../../cosense.js";
import { formatPageOutput, formatPageCompact, formatError, getSortDescription, getSortValue } from '../../utils/format.js';

/**
 * `limit` 未指定時に返すページ数。
 *
 * 以前は1000だった。484ページのプロジェクトで実測すると1回のツール結果が253KB
 * （6万トークン超）になり、クライアント側が固まったように見えるうえコンテキストを食い潰す。
 * ページ一覧は「見渡す」ためのツールなので、既定は控えめにして必要な人が明示的に上げる。
 * スキーマ側の `default` もこの定数を参照している（両者がずれると説明が嘘になる）。
 */
export const DEFAULT_LIST_LIMIT = 100;

/** ソート未指定時の既定。表示・並び順・ヘッダー表記をここで一本化する。 */
export const DEFAULT_LIST_SORT = 'updated';

export interface ListPagesParams {
  sort?: string;
  limit?: number;
  skip?: number;
  excludePinned?: boolean;
  projectName?: string | undefined;
  compact?: boolean | undefined;
}

export async function handleListPages(
  defaultProjectName: string,
  cosenseSid: string | undefined,
  params: ListPagesParams
) {
  try {
    const {
      sort,
      limit = DEFAULT_LIST_LIMIT,
      skip = 0,  // デフォルト値を設定
      excludePinned = false,
      projectName: paramsProjectName,
      compact = false
    } = params;
    const projectName = paramsProjectName || defaultProjectName;
    // sort未指定を早い段階で既定へ倒す。以前はundefinedのまま下流に流れ、
    // 並び順はcreated順・ヘッダーはupdated表記・日付欄は'Not specified'と三者が食い違っていた
    const effectiveSort = sort ?? DEFAULT_LIST_SORT;
    let pages;

    if (excludePinned) {
      const targetLimit = limit || 10;
      let unpinnedPages: ListPagesResponse['pages'] = [];
      let currentSkip = skip || 0;
      
      while (unpinnedPages.length < targetLimit) {
        const fetchedPages = await listPages(projectName, cosenseSid, {
          sort: effectiveSort,
          limit: targetLimit * 3,
          skip: currentSkip
        });
        
        const newUnpinned = fetchedPages.pages.filter(page => !page.pin || page.pin === 0);
        unpinnedPages = unpinnedPages.concat(newUnpinned);
        
        if (fetchedPages.pages.length === 0) break;
        currentSkip += fetchedPages.pages.length;
      }
      
      const actualPages = unpinnedPages.slice(0, targetLimit);
      pages = {
        ...await listPages(projectName, cosenseSid, { limit: 1 }),
        pages: actualPages,
        limit: actualPages.length,
        skip: skip || 0
      };
    } else {
      pages = await listPagesWithSort(
        projectName,
        {
          sort: effectiveSort,
          limit,
          skip,
        },
        cosenseSid
      );
    }

    let output: string;

    const countLabel = excludePinned
      ? `${pages.pages.length} unpinned (${pages.count} total)`
      : `${pages.count}`;

    if (compact) {
      const header = `${projectName} | ${countLabel} pages | sort:${effectiveSort}`;
      const lines = pages.pages.map((page) => {
        const sortValue = getSortValue(page, effectiveSort);
        return formatPageCompact(page, { sortValue: sortValue.formatted });
      });
      output = [header, ...lines].join('\n');
    } else {
      output = [
        `Project: ${projectName}`,
        `Total pages: ${countLabel}`,
        `Pages fetched: ${pages.pages.length}`,
        `Pages skipped: ${pages.skip}`,
        `Sort method: ${getSortDescription(effectiveSort)}`,
        '---'
      ].join('\n') + '\n';

      output += pages.pages.map((page, index) => {
        const sortValue = getSortValue(page, effectiveSort);
        return formatPageOutput(page, index, {
          skip: skip || 0,
          showSort: true,
          sortValue: sortValue.formatted,
          showDescriptions: true
        }) + '\n---';
      }).join('\n');
    }

    return {
      content: [{
        type: "text",
        text: output
      }]
    };
  } catch (error) {
    return formatError(
      error instanceof Error ? error.message : 'Unknown error',
      {
        Operation: 'list_pages',
        Project: params.projectName || defaultProjectName,
        Sort: params.sort || 'default',
        Limit: String(params.limit || 'default'),
        Skip: String(params.skip || '0'),
        Timestamp: new Date().toISOString(),
      },
      params.compact
    );
  }
}
