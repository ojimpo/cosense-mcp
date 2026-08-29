/**
 * 管理画面。
 *
 * 一番大事な性質は「誰が登録して使っているかは見えて、SIDは見えない」。
 * 見せない努力ではなく、見せる手段が無いことを確認する。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { resolveOAuthConfig } from '../../auth/config.js';
import { OAuthStore } from '../../auth/store.js';
import { CosenseOAuthProvider } from '../../auth/provider.js';
import { renderConsentPage } from '../../auth/pages.js';
import { createAdminApp } from '../../admin-server.js';

const OWNER_PASSPHRASE = 'owner-passphrase-1234';
const FRIEND_PASSPHRASE = 'friend-passphrase-99';
const FRIEND_SID = 's%3AveryPrivateFriendSession.zzz';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const BASE = 'https://mcp.example.com';

function fakeResponse(): Response & { body: string } {
  const res = {
    body: '',
    setHeader: () => res,
    status: () => res,
    type: () => res,
    send: (html: string) => {
      res.body = html;
      return res;
    },
  };
  return res as unknown as Response & { body: string };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

describe('管理画面', () => {
  let base: string;
  let listening: NetServer;
  let config: ReturnType<typeof resolveOAuthConfig>;
  let store: OAuthStore;
  let provider: CosenseOAuthProvider;
  let client: OAuthClientInformationFull;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosense-admin-'));
    config = resolveOAuthConfig({
      MCP_PUBLIC_URL: BASE,
      MCP_OAUTH_PASSPHRASE: OWNER_PASSPHRASE,
      MCP_USERS_STORE: join(dir, 'users-store.json'),
    })!;
    store = new OAuthStore();
    provider = new CosenseOAuthProvider(config!, store, '/oauth/consent', renderConsentPage);
    client = provider.clientsStore.registerClient!({
      client_id: 'test-client',
      client_name: 'Claude',
      redirect_uris: [REDIRECT_URI],
    } as OAuthClientInformationFull) as OAuthClientInformationFull;

    // 招待 → 登録 → トークン発行まで通し、SIDが保存された状態を作る
    const { code } = config!.invites!.create({ userId: 'taro', projects: ['shared'], enableDelete: false });
    const res = fakeResponse();
    await provider.authorize(
      client,
      { redirectUri: REDIRECT_URI, codeChallenge: 'c', scopes: ['mcp'], resource: new URL(`${BASE}/mcp`) },
      res
    );
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(res.body)![1]!;
    const redirect = provider.approve(
      pendingId,
      { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: code },
      '127.0.0.1'
    );
    await provider.exchangeAuthorizationCode(
      client,
      new URL(redirect).searchParams.get('code')!,
      'verifier',
      REDIRECT_URI,
      new URL(`${BASE}/mcp`)
    );

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const app = createAdminApp({ config: config!, store });
    listening = await new Promise<NetServer>((resolve) => {
      const server = app.listen(port, '127.0.0.1', () => resolve(server));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listening.close(() => resolve()));
  });

  async function signIn(passphrase = OWNER_PASSPHRASE): Promise<string | undefined> {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({ passphrase }),
    });
    return response.headers.get('set-cookie')?.split(';')[0];
  }

  it('ログインしていなければ何も出さない', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Operator passphrase');
    expect(html).not.toContain('taro');
  });

  it('利用者のパスフレーズでは入れない（招待された人が招待する側に回れない）', async () => {
    expect(await signIn(FRIEND_PASSPHRASE)).toBeUndefined();
    expect(await signIn('nope-nope-nope')).toBeUndefined();
  });

  it('運用者は、誰が登録していつ使ったかを見られる', async () => {
    const cookie = await signIn();
    expect(cookie).toBeTruthy();
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();

    expect(html).toContain('taro');
    expect(html).toContain('shared');
    expect(html).toContain('Claude'); // 接続しているクライアント
    expect(html).toContain('invited');
  });

  it('SIDは「保存されている」までしか出ない', async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();

    // ここが崩れたら、この設計の意味そのものが無くなる
    expect(html).not.toContain(FRIEND_SID);
    expect(html).not.toContain('veryPrivateFriendSession');
    expect(html).toContain('stored');
  });

  it('CSRFトークンが無いPOSTは通らない', async () => {
    const cookie = await signIn();
    const response = await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie! },
      redirect: 'manual',
      body: new URLSearchParams({ user_id: 'hanako' }),
    });
    expect(response.status).toBe(403);
    expect(config!.users.get('hanako')).toBeUndefined();
  });

  it('招待を発行すると、合言葉を一度だけ見せる', async () => {
    const cookie = await signIn();
    const dashboard = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(dashboard)![1]!;

    await fetch(`${base}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie! },
      redirect: 'manual',
      body: new URLSearchParams({ csrf, user_id: 'hanako', projects: 'shared, notes', ttl_hours: '24' }),
    });

    const withCode = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();
    const shown = /class="code">([a-z0-9-]+)</.exec(withCode);
    expect(shown).toBeTruthy();
    expect(shown![1]).toMatch(/^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/);

    // 保存しているのはハッシュだけなので、読み込み直しても二度は出ない
    const again = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();
    expect(again).not.toContain(shown![1]);
    expect(again).toContain('hanako');
  });

  it('利用者を消すと、認可も暗号化されたSIDも道連れになる', async () => {
    const cookie = await signIn();
    const dashboard = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(dashboard)![1]!;
    expect(store.countSids()).toBe(1);

    await fetch(`${base}/users/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie! },
      redirect: 'manual',
      body: new URLSearchParams({ csrf, user_id: 'taro' }),
    });

    expect(config!.users.get('taro')).toBeUndefined();
    // トークンだけ残すと、消したはずの人が寿命の分だけ使い続けられる
    expect(store.countSids()).toBe(0);
  });

  it('設定ファイル側の利用者は消せない', async () => {
    const cookie = await signIn();
    const dashboard = await (await fetch(`${base}/`, { headers: { Cookie: cookie! } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(dashboard)![1]!;

    const response = await fetch(`${base}/users/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie! },
      redirect: 'manual',
      body: new URLSearchParams({ csrf, user_id: 'default' }),
    });
    expect(await response.text()).toContain('cannot be removed here');
    expect(config!.users.get('default')).toBeDefined();
  });
});
