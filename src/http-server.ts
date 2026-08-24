import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import type { Express, Request, RequestHandler, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { resolveOAuthConfig, type OAuthConfig } from './auth/config.js';
import { setupOAuth } from './auth/index.js';

type ServerFactory = () => Server;

export interface HttpServerOptions {
  port: number;
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
  const { authToken, oauth, allowUnauthenticated = false, trustProxy, allowedOrigins } = options;
  const app = express();

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

  // OAuth のルーターはアプリのルートに載せる必要がある（`.well-known` を含むため）。
  // また、同意画面には CORS ヘッダを付けない。
  let requireAuth: RequestHandler | undefined;
  if (oauth) {
    const wiring = setupOAuth(oauth);
    for (const router of wiring.routers) app.use(router);
    requireAuth = wiring.requireAuth;
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

  const mcpMiddleware: RequestHandler[] = [cors(corsOptions), express.json()];
  if (requireAuth) mcpMiddleware.push(requireAuth);

  // POST /mcp - main MCP endpoint
  app.post('/mcp', ...mcpMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[${new Date().toISOString()}] POST body method=${Array.isArray(req.body) ? req.body.map((r: {method?: string}) => r.method).join(',') : req.body?.method} isInit=${isInitializeRequest(req.body)} knownSession=${!!(sessionId && transports[sessionId])}`);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        const mcpServer = createServer();
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
    if (!sessionId || !transports[sessionId]) {
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
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // startHttpServer / テストからセッションの後始末ができるよう露出しておく。
  app.locals.transports = transports;
  return app;
}

export function startHttpServer(createServer: ServerFactory, options: HttpServerOptions) {
  const app = createApp(createServer, options);
  const transports = (app.locals as { transports: Record<string, StreamableHTTPServerTransport> }).transports;

  const httpServer = app.listen(options.port, '0.0.0.0', () => {
    console.error(`MCP Streamable HTTP Server listening on http://0.0.0.0:${options.port}/mcp`);
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
