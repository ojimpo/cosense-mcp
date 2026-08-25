import { fetch } from "@whatwg-node/fetch";
import { sortPages } from './utils/sort.js';
const API_DOMAIN = process.env.API_DOMAIN || "scrapbox.io";

type FetchInit = Parameters<typeof fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Cosense API へのリクエストが返らなかったときの打ち切り時間（ミリ秒）。
 *
 * タイムアウトが無いと、API 側が詰まった瞬間に tool call が永久に返らず、
 * MCP クライアントからは「セッションがフリーズした」ようにしか見えない。
 * ここを通さない fetch を足さないこと。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function requestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COSENSE_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** SID があれば Cookie ヘッダを組み立てる。無ければ undefined（公開プロジェクト向け）。 */
function authHeaders(sid?: string): Record<string, string> | undefined {
  return sid ? { Cookie: `connect.sid=${sid}` } : undefined;
}

/**
 * タイムアウトで打ち切ったことを表すエラー。
 *
 * 専用クラスにしているのは、下流の catch が「APIエラー＝空の結果」に握り潰すため。
 * タイムアウトをそこに混ぜると「0件でした」「ページはありません」と嘘をつくことになり、
 * ハングは消えても静かに間違った答えを返すだけになる。必ず貫通させること。
 */
export class RequestTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * タイムアウト付きの fetch。
 *
 * タイマーは成功後もあえて解除せず unref だけする。fetch はヘッダを受け取った時点で
 * 解決するので、ここで clearTimeout すると本文の読み出し（`.json()` / `.text()`）が
 * 無防備になる。signal を張ったままにしておけば本文の停滞でも中断できる。
 * unref してあるのでプロセスを起こし続けることはない。
 */
async function fetchWithTimeout(url: string, sid?: string, init: FetchInit = {}): Promise<FetchResponse> {
  const timeoutMs = requestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const headers = authHeaders(sid);

  try {
    return await fetch(url, {
      ...init,
      ...(headers ? { headers } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(url, timeoutMs);
    }
    throw error;
  }
}

// /api/pages/:projectname/search/query の型定義
type SearchQueryResponse = {
  projectName: string; // data取得先のproject名
  searchQuery: string; // 検索語句
  query: {
    words: string[]; // AND検索に使った語句
    excludes: string[]; // NOT検索に使った語句
  };
  limit: number; // 検索件数の上限
  count: number; // 検索件数
  existsExactTitleMatch: boolean;
  backend: 'elasticsearch';
  pages: {
    id: string;
    title: string;
    image: string;
    words: string[];
    lines: string[];
    created?: number;
    updated?: number;
    user?: {
      id: string;
      name: string;
      displayName: string;
      photo: string;
    };
    lastUpdateUser?: {
      id: string;
      name: string;
      displayName: string;
      photo: string;
    };
    collaborators?: {
      id: string;
      name: string;
      displayName: string;
      photo: string;
    }[];
  }[];
  debug?: {  // デバッグ情報を追加
    request_url?: string;
    query?: string;
    total_results?: number;
    error?: string;
  };
};

// /api/pages/:projectname/:pagetitle
type GetPageResponse = {
  id: string;
  title: string;
  lines: {
    id: string;
    text: string;
    userId: string;
    created: number;
    updated: number;
  }[];
  created: number;
  updated: number;
  links: string[];
  relatedPages: {
    links1hop: {
      title: string;
      descriptions: string[];
    }[];
  };
  user: {              // 追加: 最新の編集者情報
    id: string;
    name: string;
    displayName: string;
    photo: string;
  };
  lastUpdateUser?: {
    id: string;
    name: string;
    displayName: string;
    photo: string;
  } | undefined;
  collaborators: {
    id: string;
    name: string;
    displayName: string;
    photo: string;
  }[];
  persistent?: boolean | undefined;
  debug?: {
    error?: string;
    warning?: string;
  } | undefined;
};

async function getPage(
  projectName: string,
  pageName: string,
  sid?: string,
): Promise<GetPageResponse | null> {
  try {
    const url = `https://${API_DOMAIN}/api/pages/${projectName}/${encodeURIComponent(pageName)}`;
    

    const response = await fetchWithTimeout(url, sid);

    if (!response.ok) {
      return null;
    }

    const page = await response.json();
    
    // レスポンスの型チェック
    if (!page || typeof page !== 'object') {
      return null;
    }

    const typedPage = page as GetPageResponse;
    if (!Array.isArray(typedPage.lines)) {
      return {
        ...typedPage,
        debug: {
          error: 'Invalid page response format: lines is not an array'
        }
      };
    }

    // userとlastUpdateUserの整合性チェック
    if (!typedPage.user && typedPage.lastUpdateUser) {
      // lastUpdateUserが存在するがuserが存在しない場合
      return {
        ...typedPage,
        user: typedPage.lastUpdateUser,
        debug: {
          warning: `Using lastUpdateUser as fallback for user information on page: ${typedPage.title}`
        }
      };
    } else if (!typedPage.user) {
      // どちらの情報も存在しない場合
      return {
        ...typedPage,
        debug: {
          warning: `Missing both user and lastUpdateUser information for page: ${typedPage.title}`
        }
      };
    }

    return typedPage;
  } catch (error) {
    // タイムアウトは「ページが無い」と区別がつかなくなるので握り潰さない
    if (error instanceof RequestTimeoutError) throw error;
    return null;
  }
}

function toReadablePage(page: GetPageResponse): {
  title: string;
  lines: {
    id: string;
    text: string;
    userId: string;
    created: number;
    updated: number;
  }[];
  created: number;
  updated: number;
  user: {
    id: string;
    name: string;
    displayName: string;
    photo: string;
  };
  lastUpdateUser?: {
    id: string;
    name: string;
    displayName: string;
    photo: string;
  } | undefined;
  collaborators: {
    id: string;
    name: string;
    displayName: string;
    photo: string;
  }[];
  links: string[];
} {
  return {
    title: page.title,
    lines: page.lines,
    created: page.created,
    updated: page.updated,
    user: page.user,
    lastUpdateUser: page.lastUpdateUser ?? undefined,
    collaborators: page.collaborators ?? [],
    links: page.links,
  };
}


// /api/pages/:projectname
type ListPagesResponse = {
  limit: number;
  count: number;
  skip: number;
  projectName: string;
  pages: {
    title: string;
    lastAccessed?: number | undefined;
    created?: number | undefined;
    updated?: number | undefined;
    accessed?: number | undefined;
    views?: number | undefined;
    linked?: number | undefined;
    pin?: number | undefined;
    user?: {
      id: string;
      name: string;
      displayName: string;
      photo: string;
    } | undefined;
    lastUpdateUser?: {
      id: string;
      name: string;
      displayName: string;
      photo: string;
    } | undefined;
  }[];
};

// デバッグ情報の型を拡張
type DebugInfo = {
  request_url?: string;
  params?: Record<string, string>;
  error?: string;
  originalCount?: number;
  filteredCount?: number;
  appliedSort?: string;
  excludedPinned?: boolean;
  total_results?: number;
};

async function listPages(
  projectName: string,
  sid?: string,
  options: { limit?: number | undefined; skip?: number | undefined; sort?: string | undefined; excludePinned?: boolean | undefined } = {}
): Promise<ListPagesResponse & { debug?: DebugInfo }> {
  try {
    const { sort, excludePinned } = options;
    
    // クエリパラメータの構築
    const sortValue = options.sort || 'updated';
    const params = new URLSearchParams({
      limit: (options.limit || 1000).toString(),
      skip: (options.skip || 0).toString(),
      sort: sortValue
    });

    const url = `https://${API_DOMAIN}/api/pages/${projectName}?${params}`;
    
    
    // デバッグ情報を含めるための変数
    const debugInfo: DebugInfo = {
      request_url: url,
      params: Object.fromEntries(params.entries())
    };

    const response = await fetchWithTimeout(url, sid);
    
    if (!response.ok) {
      return {
        limit: 0,
        count: 0,
        skip: 0,
        projectName: projectName,
        pages: [],
        debug: {
          ...debugInfo,
          error: `API error: ${response.status} ${response.statusText}`
        }
      };
    }

    const pages = await response.json();
    const pagesWithDetails = await Promise.all(
      (pages as ListPagesResponse).pages.map(async (page) => {
        const pageDetails = await getPage(projectName, page.title, sid);
        if (pageDetails) {
          return {
            ...page,
            user: pageDetails.user,
            lastUpdateUser: pageDetails.lastUpdateUser,
            created: pageDetails.created,
            updated: pageDetails.updated,
            collaborators: pageDetails.collaborators,
            descriptions: pageDetails.lines?.slice(0, 5).map(line => line.text) || []
          };
        }
        return page;
      })
    );

    // ソートとフィルタリングを適用
    const sortedPages = sortPages(pagesWithDetails, { 
      sort: sort ?? undefined, 
      excludePinned: excludePinned ?? undefined 
    });

    return {
      ...(pages as ListPagesResponse),
      pages: sortedPages,
      debug: {
        ...debugInfo,
        originalCount: pagesWithDetails.length,
        filteredCount: sortedPages.length,
        appliedSort: sort || 'created',
        excludedPinned: excludePinned || false
      }
    };

  } catch (error) {
    // タイムアウトは「0件」と区別がつかなくなるので握り潰さない
    if (error instanceof RequestTimeoutError) throw error;
    return {
      limit: 0,
      count: 0,
      skip: 0,
      projectName: projectName,
      pages: [],
      debug: {
        error: error instanceof Error ? error.message : '不明なエラー'
      }
    };
  }
}

function encodeScrapboxBody(body: string): string {
  // Scrapboxの本文用にエンコード
  return encodeURIComponent(body);
}

function createPageUrl(projectName: string, title: string, body?: string): string {
  const baseUrl = `https://${API_DOMAIN}/${projectName}/${encodeURIComponent(title)}`;
  return body ? `${baseUrl}?body=${encodeScrapboxBody(body)}` : baseUrl;
}

/**
 * プロジェクト内のページを全文検索します
 * @param projectName プロジェクト名
 * @param query 検索クエリ
 * @param sid セッションID（オプション）
 * @returns 検索結果
 * 
 * 使用例:
 * - 基本的な検索: searchPages("projectname", "検索語句")
 * - 複数語句での検索: searchPages("projectname", "word1 word2")
 * - 除外検索: searchPages("projectname", "word1 -word2")
 * - フレーズ検索: searchPages("projectname", '"exact phrase"')
 */
async function searchPages(
  projectName: string,
  query: string,
  sid?: string
): Promise<SearchQueryResponse | null> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://${API_DOMAIN}/api/pages/${projectName}/search/query?q=${encodedQuery}`;
  
  const debugInfo = {
    request_url: url,
    searchQuery: query,
  };

  const response = await fetchWithTimeout(url, sid);

  if (!response.ok) {
    return {
      projectName,
      searchQuery: query,
      query: { words: [], excludes: [] },
      limit: 0,
      count: 0,
      existsExactTitleMatch: false,
      backend: 'elasticsearch',
      pages: [],
      debug: {
        ...debugInfo,
        error: `Search API error: ${response.status} ${response.statusText}`
      }
    };
  }

  const result = await response.json();
  return {
    projectName,
    searchQuery: query,
    query: result.query,
    limit: result.limit,
    count: result.count,
    existsExactTitleMatch: result.existsExactTitleMatch,
    backend: result.backend,
    pages: result.pages,
    debug: {
      ...debugInfo,
      total_results: result.pages.length
    }
  };
}

/**
 * ピン留めページを考慮してソートされたページリストを取得する
 */
async function listPagesWithSort(
  projectName: string,
  options: {
    limit: number;
    skip: number;
    sort?: string | undefined;
    excludePinned?: boolean | undefined;
  },
  sid?: string
): Promise<ListPagesResponse> {
  const skip = options.skip || 0;
  const limit = options.limit;
  const fetchSize = limit + skip + 100; // skip + limit + 余裕を持って取得

  // 1. より多くのページを一度に取得
  const response = await listPages(projectName, sid, {
    limit: fetchSize,
    skip: 0, // 最初から取得して後でskipを適用
    excludePinned: options.excludePinned ?? false
  });

  // 2. 取得したページをメモリ上でソート
  const sortedPages = sortPages(response.pages, { 
    sort: options.sort ?? undefined, 
    excludePinned: options.excludePinned ?? undefined 
  });

  // 3. skip位置から必要な件数を切り出し
  const resultPages = sortedPages.slice(skip, skip + limit);

  // 4. 結果を返す
  return {
    ...response,
    pages: resultPages,
    limit: resultPages.length,
    skip: skip
  };
}

type SmartContextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Smart Context APIでページとリンク先ページのコンテンツを一括取得する
 * @param projectName プロジェクト名
 * @param title ページタイトル
 * @param hopCount リンクのホップ数（1 or 2）
 * @param sid セッションID（必須）
 * @returns 成功時はテキスト、失敗時はエラーメッセージ
 */
async function getSmartContext(
  projectName: string,
  title: string,
  hopCount: 1 | 2,
  sid: string,
): Promise<SmartContextResult> {
  try {
    const url = `https://${API_DOMAIN}/api/smart-context/export-${hopCount}hop-links/${projectName}.txt?title=${encodeURIComponent(title)}`;

    const response = await fetchWithTimeout(url, sid);

    if (!response.ok) {
      return { ok: false, error: `API error: ${response.status} ${response.statusText}` };
    }

    return { ok: true, text: await response.text() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown network error' };
  }
}

// 型のエクスポート
export type { ListPagesResponse };

// 関数のエクスポート
export { getPage, listPages, listPagesWithSort, toReadablePage, createPageUrl, searchPages, getSmartContext };
// テスト用（タイムアウトが実際に発火するかを検証するため）
export { fetchWithTimeout, requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS };
