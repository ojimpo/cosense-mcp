import type { Response } from 'express';
import { CosenseOAuthProvider, ConsentError, PendingNotFoundError, canonicalizeResource } from '../../auth/provider.js';
import { OAuthStore } from '../../auth/store.js';
import { resolveOAuthConfig } from '../../auth/config.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const PASSPHRASE = 'correct-horse-battery';
const RESOURCE = 'https://cosense-mcp.example.com/mcp';

const config = resolveOAuthConfig({
  MCP_PUBLIC_URL: 'https://cosense-mcp.example.com',
  MCP_OAUTH_PASSPHRASE: PASSPHRASE,
})!;

const client = {
  client_id: 'client-1',
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
} as OAuthClientInformationFull;

interface FakeResponse {
  res: Response;
  body: () => string;
  headers: Record<string, string>;
}

function fakeResponse(): FakeResponse {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: () => res,
    type: () => res,
    send: (value: string) => {
      body = value;
      return res;
    },
  } as unknown as Response;
  return { res, body: () => body, headers };
}

function build() {
  const store = new OAuthStore();
  const provider = new CosenseOAuthProvider(config, store, '/oauth/consent', (params) =>
    JSON.stringify(params)
  );
  store.saveClient(client);
  return { store, provider };
}

/** 認可リクエストを出して pendingId を取り出す。 */
async function startAuthorization(
  provider: CosenseOAuthProvider,
  overrides: { resource?: URL; state?: string; scopes?: string[] } = {}
): Promise<string> {
  const response = fakeResponse();
  await provider.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0]!,
      codeChallenge: 'challenge-value',
      ...(overrides.state !== undefined ? { state: overrides.state } : {}),
      ...(overrides.scopes !== undefined ? { scopes: overrides.scopes } : {}),
      ...(overrides.resource !== undefined ? { resource: overrides.resource } : {}),
    },
    response.res
  );
  return JSON.parse(response.body()).pendingId as string;
}

describe('canonicalizeResource', () => {
  it('末尾スラッシュとフラグメントを吸収する', () => {
    expect(canonicalizeResource('https://a.example.com/mcp/')).toBe('https://a.example.com/mcp');
    expect(canonicalizeResource('https://a.example.com/mcp#x')).toBe('https://a.example.com/mcp');
  });
});

describe('CosenseOAuthProvider', () => {
  it('認可リクエストは同意画面を返し、まだリダイレクトしない', async () => {
    const { provider } = build();
    const response = fakeResponse();
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge: 'c', scopes: [] },
      response.res
    );
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['X-Frame-Options']).toBe('DENY');
    expect(JSON.parse(response.body()).clientName).toBe('Claude');
  });

  it('CSPのform-actionにリダイレクト先のオリジンを含める', async () => {
    const { provider } = build();
    const response = fakeResponse();
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge: 'c', scopes: [] },
      response.res
    );
    // これが無いと承認後の302をブラウザがブロックし、押しても無反応に見える
    expect(response.headers['Content-Security-Policy']).toContain("form-action 'self' https://claude.ai");
  });

  it('同じpendingを再送信しても同じリダイレクトを返す（行き止まりにしない）', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider, { state: 'dup' });
    const first = provider.approve(pendingId, PASSPHRASE, 'ip');
    const second = provider.approve(pendingId, PASSPHRASE, 'ip');
    expect(second).toBe(first);

    // 使い回されたコードでも、トークン交換は1回しか通らない
    const code = new URL(first).searchParams.get('code')!;
    await provider.exchangeAuthorizationCode(client, code);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid or expired/);
  });

  it('再送信でもパスフレーズは毎回検証する', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    provider.approve(pendingId, PASSPHRASE, 'ip');
    expect(() => provider.approve(pendingId, 'wrong-passphrase', 'ip2')).toThrow(ConsentError);
  });

  it('別リソース宛の認可リクエストを拒否する', async () => {
    const { provider } = build();
    await expect(
      startAuthorization(provider, { resource: new URL('https://evil.example.com/mcp') })
    ).rejects.toThrow(/Unsupported resource/);
  });

  it('承認するとcode・state・issを付けてリダイレクトする', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider, { state: 'xyz' });
    const redirect = new URL(provider.approve(pendingId, PASSPHRASE, 'ip'));

    expect(redirect.origin + redirect.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(redirect.searchParams.get('state')).toBe('xyz');
    // ChatGPTは iss を見て固定のリダイレクトURIを使う
    expect(redirect.searchParams.get('iss')).toBe('https://cosense-mcp.example.com');
    expect(redirect.searchParams.get('code')).toBeTruthy();
  });

  it('パスフレーズが違えば認可コードを出さない', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    expect(() => provider.approve(pendingId, 'wrong-passphrase', 'ip')).toThrow(ConsentError);
    // pending は消えないので画面を出し直せる
    expect(provider.renderConsentFor(pendingId, 'Incorrect passphrase.')).toContain('Incorrect passphrase');
  });

  it('パスフレーズ試行が一定回数を超えると止まる', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    for (let i = 0; i < 10; i += 1) {
      expect(() => provider.approve(pendingId, 'wrong-passphrase', 'ip')).toThrow(/Incorrect/);
    }
    expect(() => provider.approve(pendingId, PASSPHRASE, 'ip')).toThrow(/Too many attempts/);
  });

  it('拒否するとaccess_deniedでリダイレクトする', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider, { state: 's' });
    const redirect = new URL(provider.deny(pendingId));
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('s');
  });

  it('未知・期限切れのpendingは専用エラーになる', () => {
    const { provider } = build();
    expect(() => provider.approve('nope', PASSPHRASE, 'ip')).toThrow(PendingNotFoundError);
  });

  it('PKCEチャレンジを引き当ててトークンを発行する', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider, { resource: new URL(RESOURCE) });
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge-value');

    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], new URL(RESOURCE));
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toBeTruthy();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
    expect(info.resource?.href).toBe(RESOURCE);
  });

  it('認可コードは1回しか使えず、再利用でそのクライアントのトークンが失効する', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid or expired/);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/invalid or expired/i);
  });

  it('トークン交換時のresource不一致を拒否する', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, undefined, new URL('https://evil.example.com/mcp'))
    ).rejects.toThrow(/Unsupported resource/);
  });

  it('redirect_uriが認可時と違えば拒否する', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://claude.ai/other')
    ).rejects.toThrow(/redirect_uri does not match/);
  });

  it('リフレッシュトークンはローテーションし、旧トークンは使えない', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    const first = await provider.exchangeAuthorizationCode(client, code);

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    expect(second.access_token).not.toBe(first.access_token);
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(/Invalid or expired/);
  });

  it('リフレッシュでスコープを広げられない', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider, { scopes: ['mcp'] });
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, ['mcp', 'admin'])).rejects.toThrow(/Cannot widen scope/);
  });

  it('別リソース向けに発行されたトークンを受け付けない', async () => {
    const { store, provider } = build();
    store.saveAccessToken('foreign-token', {
      clientId: 'client-1',
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: 'https://other.example.com/mcp',
    });
    await expect(provider.verifyAccessToken('foreign-token')).rejects.toThrow(/not issued for this resource server/);
  });

  it('取り消したトークンは検証に通らない', async () => {
    const { provider } = build();
    const pendingId = await startAuthorization(provider);
    const code = new URL(provider.approve(pendingId, PASSPHRASE, 'ip')).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    await provider.revokeToken(client, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('redirect_uriがhttpsでもloopbackでもないクライアント登録を拒否する', () => {
    const { provider } = build();
    expect(() =>
      provider.clientsStore.registerClient!({
        redirect_uris: ['http://evil.example.com/cb'],
      } as OAuthClientInformationFull)
    ).toThrow(/must be https/);
  });

  it('DCRで登録したクライアントを引ける', () => {
    const { provider } = build();
    provider.clientsStore.registerClient!({
      client_id: 'client-2',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    } as OAuthClientInformationFull);
    expect(provider.clientsStore.getClient('client-2')).toBeDefined();
  });
});
