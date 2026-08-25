import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchWithTimeout,
  requestTimeoutMs,
  RequestTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../cosense.js';

describe('requestTimeoutMs', () => {
  it('未設定なら既定値を使う', () => {
    expect(requestTimeoutMs({})).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutMs({ COSENSE_REQUEST_TIMEOUT_MS: '   ' })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('数値として読める正の値だけを採用する', () => {
    expect(requestTimeoutMs({ COSENSE_REQUEST_TIMEOUT_MS: '5000' })).toBe(5000);
    // 不正値で無制限（＝ハング）に落ちないこと。ここが緩むとフリーズが復活する
    expect(requestTimeoutMs({ COSENSE_REQUEST_TIMEOUT_MS: '0' })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutMs({ COSENSE_REQUEST_TIMEOUT_MS: '-1' })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutMs({ COSENSE_REQUEST_TIMEOUT_MS: 'abc' })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});

describe('fetchWithTimeout', () => {
  // 接続は受けるが一切応答を返さないサーバー。詰まったCosense APIの代役
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(() => {
      /* わざと応答しない */
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it('応答が返らないリクエストを打ち切る', async () => {
    const previous = process.env.COSENSE_REQUEST_TIMEOUT_MS;
    process.env.COSENSE_REQUEST_TIMEOUT_MS = '300';
    try {
      const started = Date.now();
      // 専用の型で投げること。下流の catch はこの型だけを貫通させている
      await expect(fetchWithTimeout(`${baseUrl}/stalls`)).rejects.toThrow(RequestTimeoutError);
      await expect(fetchWithTimeout(`${baseUrl}/stalls`)).rejects.toThrow(/timed out after 300ms/);
      // 既定の30秒ではなく、設定した300msで打ち切られていること
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      if (previous === undefined) delete process.env.COSENSE_REQUEST_TIMEOUT_MS;
      else process.env.COSENSE_REQUEST_TIMEOUT_MS = previous;
    }
  }, 10000);

  it('タイムアウト前に返る応答は素通しする', async () => {
    const ok = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    await new Promise<void>(resolve => ok.listen(0, '127.0.0.1', resolve));
    const { port } = ok.address() as AddressInfo;
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/fine`);
      expect(res.ok).toBe(true);
      await expect(res.json()).resolves.toEqual({ hello: 'world' });
    } finally {
      await new Promise<void>(resolve => ok.close(() => resolve()));
    }
  }, 10000);
});
