import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

type ServerFactory = () => Server;

export function startHttpServer(
  createServer: ServerFactory,
  options: { port: number; authToken?: string | undefined }
) {
  const { port, authToken } = options;
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Optional bearer token auth
  if (authToken) {
    app.use('/mcp', (req: Request, res: Response, next) => {
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
    });
  }

  // Request logging
  app.use((req: Request, _res: Response, next) => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} session=${req.headers['mcp-session-id'] || 'none'}`);
    next();
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // POST /mcp - main MCP endpoint
  app.post('/mcp', async (req: Request, res: Response) => {
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
        console.error(`[${new Date().toISOString()}] POST /mcp rejected: no session ID and not initialize`);
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
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      console.error(`[${new Date().toISOString()}] GET /mcp unknown session=${sessionId}, returning 404`);
      res.status(404).send('Session not found');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp - session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
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

  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.error(`MCP Streamable HTTP Server listening on http://0.0.0.0:${port}/mcp`);
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
}
