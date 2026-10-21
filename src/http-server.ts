import { randomUUID } from 'node:crypto';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { resolveOAuthConfig, type OAuthConfig } from './auth/config.js';
import { setupOAuth, type OAuthWiring } from './auth/index.js';
import { OriginValidator } from './auth/origin.js';

const jsonRpcError = (res: Response, status: number, code: number, message: string): void => {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

/**
 * セッションごとの MCP サーバーを作る。認証済みなら、その接続の `AuthInfo` を渡す
 * ——利用者ごとに SID・許可プロジェクト・使えるツールが変わるため。
 */
type ServerFactory = (authInfo?: AuthInfo) => Server;

export interface HttpServerOptions {
  port: number;
  /** 待ち受けるアドレス。既定はこのマシンの中だけ（コンテナで公開するなら 0.0.0.0 を明示する）。 */
  host?: string;
  /** Host ヘッダの許可リスト。0.0.0.0 などで待ち受けるときに DNS リバインディングを防ぐ。 */
  allowedHosts?: string[] | undefined;
  /**
   * 固定 Bearer トークンによる認証（OAuth 未設定時のローカル用フォールバック）。
   * Claude.ai の static_headers は beta、ChatGPT は固定ヘッダ自体を受け付けないため、
   * 公開エンドポイントでこれを主認証にはしない。
   */
  authToken?: string | undefined;
  oauth?: OAuthConfig | undefined;
  /** 認証をどれも設定せずに公開することを明示的に許可する。 */
  allowUnauthenticated?: boolean;
  /** リバースプロキシ配下で接続元 IP を復元する（`trust proxy` に渡す値）。 */
  trustProxy?: string | number | boolean | undefined;
  /** CORS を許可するオリジン。未指定なら全許可（Bearer 必須なので Cookie 経由の悪用は無い）。 */
  allowedOrigins?: string[] | undefined;
  /**
   * OAuth の配線が済んだ時点で呼ばれる。管理画面が同じトークンストアを見るために要る
   * ——別インスタンスを作ると、発行済みの認可が見えない管理画面ができあがる。
   */
  onAuthWiring?: ((wiring: OAuthWiring) => void) | undefined;
}

function buildCorsOptions(allowedOrigins: string[] | undefined): CorsOptions {
  const base: CorsOptions = {
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
  };
  if (!allowedOrigins || allowedOrigins.length === 0) return base;
  return { ...base, origin: allowedOrigins };
}

/**
 * MCP の HTTP エンドポイントを持つ Express アプリを組み立てる。
 * テストからポートを開かずに叩けるよう、`startHttpServer` とは分けてある。
 */
export function createApp(createServer: ServerFactory, options: HttpServerOptions): Express {
  const {
    host = '127.0.0.1',
    allowedHosts,
    authToken,
    oauth,
    allowUnauthenticated = false,
    trustProxy,
    allowedOrigins,
  } = options;
  // Host ヘッダの検証と JSON ボディの読み取りは SDK の既定に任せる（検証が先なので、
  // 許可されない Host はボディを読まずに 403 になる）
  const app = createMcpExpressApp({ host, ...(allowedHosts ? { allowedHosts } : {}) });

  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  if (!oauth && !authToken && !allowUnauthenticated) {
    // 「認証設定は書いてあるのに効いていない」状態で公開してしまった事故があるため、
    // 無認証で起動させたい場合は明示的に宣言させる。
    throw new Error(
      'Refusing to start the HTTP transport without authentication. ' +
        'Set MCP_PUBLIC_URL + MCP_OAUTH_PASSPHRASE to enable OAuth, or set MCP_ALLOW_UNAUTHENTICATED=true to opt out.'
    );
  }

  // Request logging。OAuth のルーターより先に載せること — 後ろに置くと
  // /authorize や /oauth/consent がログに一切残らず、認可の失敗を追えなくなる。
  app.use((req: Request, _res: Response, next) => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} session=${req.headers['mcp-session-id'] || 'none'}`);
    next();
  });

  const corsOptions = buildCorsOptions(allowedOrigins);

  // MCP 仕様は Origin の検証を MUST としている（DNSリバインディング対策）。
  // 既定は report モード — 実トラフィックに何が来ているか分かる前に締めると、
  // 未知のクライアントが Origin を送ってきた瞬間に本番が落ちる。
  const originValidator = new OriginValidator(allowedOrigins, oauth?.issuerUrl.origin);
  const checkOrigin: RequestHandler = (req, res, next) => {
    const verdict = originValidator.check(req.headers.origin);
    if (verdict.reason) {
      console.error(
        `[origin] ${verdict.allowed ? 'would block' : 'blocked'} ${req.method} ${req.path}: ${verdict.reason}`
      );
    }
    if (!verdict.allowed) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Forbidden: Origin not allowed' },
        id: null,
      });
      return;
    }
    next();
  };
  console.error(`[origin] validation policy: ${originValidator.policy}`);

  // OAuth のルーターはアプリのルートに載せる必要がある（`.well-known` を含むため）。
  // また、同意画面には CORS ヘッダを付けない。
  let requireAuth: RequestHandler | undefined;
  if (oauth) {
    const wiring = setupOAuth(oauth);
    for (const router of wiring.routers) app.use(router);
    requireAuth = wiring.requireAuth;
    options.onAuthWiring?.(wiring);
    console.error(`[oauth] enabled: issuer=${oauth.issuerUrl.origin} resource=${oauth.resourceUrl.href}`);
  } else if (authToken) {
    requireAuth = (req: Request, res: Response, next) => {
      const header = req.headers.authorization;
      if (!header || header !== `Bearer ${authToken}`) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
        return;
      }
      next();
    };
    console.error('[auth] static bearer token enabled');
  } else {
    console.error('[auth] WARNING: no authentication configured; this endpoint is open to anyone who knows the URL');
  }

  // Health check
  app.get('/health', cors(corsOptions), (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // セッションIDと「そのセッションを開いた認可」の対応。
  // transports は Mcp-Session-Id を引くだけなので、これが無いと、セッションIDを知った
  // 別のトークン保持者がそのセッションにそのまま乗れてしまう。全員が同じ SID と
  // 同じ許可プロジェクトで動いている間は実害が無いが、利用者ごとに設定を分けた瞬間に
  // これは権限の乗っ取りになる。分離を入れる前にここを閉じておく。
  const sessionOwners: Record<string, string> = {};

  /**
   * そのリクエストが属する認可を表すキー。
   * grantId はリフレッシュをまたいで不変なので、トークンが更新されてもセッションは切れない。
   */
  const ownerKey = (req: Request): string => {
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    if (!auth) return 'unauthenticated';
    const grantId = (auth.extra as { grantId?: unknown } | undefined)?.grantId;
    return typeof grantId === 'string' ? `grant:${grantId}` : `client:${auth.clientId}`;
  };

  /**
   * 既存セッションを、それを開いたのとは別の認可から触っていないか。
   * 拒否は 404 に寄せる（403 だと「そのセッションIDは実在する」と教えることになる）。
   */
  const ownsSession = (req: Request, sessionId: string): boolean => {
    if (sessionOwners[sessionId] === ownerKey(req)) return true;
    console.error(`[auth] session ${sessionId} was not opened by ${ownerKey(req)}; refusing`);
    return false;
  };

  const sessionNotFound = (res: Response): void => {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found. Please re-initialize.' },
      id: null,
    });
  };

  const mcpMiddleware: RequestHandler[] = [cors(corsOptions), checkOrigin];
  if (requireAuth) mcpMiddleware.push(requireAuth);

  // POST /mcp - main MCP endpoint
  app.post('/mcp', ...mcpMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[${new Date().toISOString()}] POST body method=${Array.isArray(req.body) ? req.body.map((r: {method?: string}) => r.method).join(',') : req.body?.method} isInit=${isInitializeRequest(req.body)} knownSession=${!!(sessionId && transports[sessionId])}`);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        if (!ownsSession(req, sessionId)) {
          sessionNotFound(res);
          return;
        }
        transport = transports[sessionId];
      } else if (isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
            sessionOwners[sid] = ownerKey(req);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            delete sessionOwners[sid];
          }
        };

        const mcpServer = createServer((req as Request & { auth?: AuthInfo }).auth);
        await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId && !transports[sessionId]) {
        // Unknown session ID — return 404 so client re-initializes
        console.error(`[${new Date().toISOString()}] POST /mcp unknown session=${sessionId}, returning 404 to trigger re-init`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Please re-initialize.' },
          id: null,
        });
        return;
      } else {
        // 仕様どおりの応答。「セッションIDを要求するサーバーは、initialize 以外の
        // セッション無しリクエストに 400 を返す SHOULD」(MCP Streamable HTTP)。
        // Claude.ai は initialize の前に server/discover を投げてくるので、ここは
        // 定常的に通る。事故ではないので警告に見える文言にしない。
        console.error(`[${new Date().toISOString()}] POST /mcp 400 (no session, method=${req.body?.method}) — expected for pre-initialize probes`);
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] POST /mcp error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp - SSE streaming
  app.get('/mcp', ...mcpMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId] || !ownsSession(req, sessionId)) {
      console.error(`[${new Date().toISOString()}] GET /mcp unknown session=${sessionId}, returning 404`);
      res.status(404).send('Session not found');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp - session termination
  app.delete('/mcp', ...mcpMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    if (!ownsSession(req, sessionId)) {
      res.status(404).send('Session not found');
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // express.json() が失敗したとき（壊れた JSON、上限を超える本文）の応答。
  // これが無いと Express 既定のハンドラに渡り、NODE_ENV が production 以外ではスタックトレース入りの
  // HTML が返る。ルートより後ろに置くこと（エラーハンドラは登録順で効く）
  const bodyError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') {
      jsonRpcError(res, 400, -32700, 'Parse error: the request body is not valid JSON');
    } else if (type === 'entity.too.large') {
      jsonRpcError(res, 413, -32600, 'Request body too large');
    } else {
      console.error('[http] unhandled error:', err);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };
  app.use(bodyError);

  // startHttpServer / テストからセッションの後始末ができるよう露出しておく。
  app.locals.transports = transports;
  return app;
}

export function startHttpServer(createServer: ServerFactory, options: HttpServerOptions) {
  const app = createApp(createServer, options);
  const transports = (app.locals as { transports: Record<string, StreamableHTTPServerTransport> }).transports;

  const host = options.host ?? '127.0.0.1';
  const httpServer = app.listen(options.port, host, () => {
    console.error(`MCP Streamable HTTP Server listening on http://${host}:${options.port}/mcp`);
  });

  const cleanup = async () => {
    for (const sid in transports) {
      try {
        await transports[sid]?.close();
        delete transports[sid];
      } catch {
        // ignore cleanup errors
      }
    }
    httpServer.close();
  };

  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  return httpServer;
}

export { resolveOAuthConfig };
