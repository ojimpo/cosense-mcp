/**
 * SID の封筒暗号。
 *
 * 守りたい性質は2つだけで、どちらも「保存されたものから平文が出ないこと」に尽きる:
 * ストアファイルに平文が現れないこと、そして復号がトークンの提示を要求すること。
 * リフレッシュでトークンがローテートしたときに包み直しそこねると、その利用者の SID は
 * 二度と開けなくなる（＝再認可して入力し直し）ので、そこも固定しておく。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { resolveOAuthConfig } from '../../auth/config.js';
import { OAuthStore } from '../../auth/store.js';
import { ConsentError, CosenseOAuthProvider } from '../../auth/provider.js';
import { renderConsentPage } from '../../auth/pages.js';
import { hashPassphrase } from '../../auth/users.js';
import { SidDecryptError, generateDek, sealSid, unwrapDek, wrapDek } from '../../auth/sid-crypto.js';

const OWNER_PASSPHRASE = 'owner-passphrase-1234';
const FRIEND_PASSPHRASE = 'friend-passphrase-99';
const FRIEND_SID = 's%3AsuperSecretCosenseSession.abcdef123456';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const BASE = 'https://mcp.example.com';

/** provider.authorize は Express の Response しか受け取らないので、最小限の偽物を渡す。 */
function fakeResponse(): Response & { body: string } {
  const res = {
    body: '',
    setHeader() {
      return res;
    },
    status() {
      return res;
    },
    type() {
      return res;
    },
    send(html: string) {
      res.body = html;
      return res;
    },
  };
  return res as unknown as Response & { body: string };
}

interface Harness {
  provider: CosenseOAuthProvider;
  store: OAuthStore;
  storePath: string;
  client: OAuthClientInformationFull;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cosense-sid-'));
  const usersFile = join(dir, 'users.json');
  writeFileSync(
    usersFile,
    JSON.stringify({
      version: 1,
      users: [{ id: 'friend', passphraseHash: hashPassphrase(FRIEND_PASSPHRASE), sidSource: 'consent' }],
    })
  );
  const storePath = join(dir, 'oauth-store.json');
  const config = resolveOAuthConfig({
    MCP_PUBLIC_URL: BASE,
    MCP_OAUTH_PASSPHRASE: OWNER_PASSPHRASE,
    MCP_USERS_FILE: usersFile,
    MCP_OAUTH_STORE: storePath,
  })!;
  const store = new OAuthStore(storePath);
  const provider = new CosenseOAuthProvider(config, store, '/oauth/consent', renderConsentPage);
  const client = provider.clientsStore.registerClient!({
    client_id: 'test-client',
    redirect_uris: [REDIRECT_URI],
  } as OAuthClientInformationFull) as OAuthClientInformationFull;
  return { provider, store, storePath, client };
}

async function beginConsent(h: Harness): Promise<string> {
  const res = fakeResponse();
  await h.provider.authorize(
    h.client,
    {
      redirectUri: REDIRECT_URI,
      codeChallenge: 'challenge',
      scopes: ['mcp'],
      resource: new URL(`${BASE}/mcp`),
    },
    res
  );
  return /name="pending_id" value="([^"]+)"/.exec(res.body)![1]!;
}

function codeFrom(redirect: string): string {
  return new URL(redirect).searchParams.get('code')!;
}

async function fullFlow(h: Harness, sid: string) {
  const pendingId = await beginConsent(h);
  const code = codeFrom(h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid }, '127.0.0.1'));
  return h.provider.exchangeAuthorizationCode(h.client, code, 'verifier', REDIRECT_URI, new URL(`${BASE}/mcp`));
}

describe('SIDの封筒暗号', () => {
  it('同意画面で入力したSIDが、そのトークンでだけ取り出せる', async () => {
    const h = harness();
    const tokens = await fullFlow(h, FRIEND_SID);

    const authInfo = await h.provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.extra?.cosenseSid).toBe(FRIEND_SID);
    expect(authInfo.extra?.userId).toBe('friend');
  });

  it('保存されたストアに平文のSIDは現れない', async () => {
    const h = harness();
    await fullFlow(h, FRIEND_SID);
    h.store.flush();

    const raw = readFileSync(h.storePath, 'utf-8');
    expect(raw).not.toContain(FRIEND_SID);
    // 断片でも出てこないこと（base64ではなく生の値が混ざっていないか）
    expect(raw).not.toContain('superSecretCosenseSession');
    // 暗号文自体は保存されている（「そもそも保存していないから漏れない」ではない）
    expect(h.store.countSids()).toBe(1);
  });

  it('リフレッシュでトークンがローテートしても復号し続けられる', async () => {
    const h = harness();
    const first = await fullFlow(h, FRIEND_SID);

    const second = await h.provider.exchangeRefreshToken(
      h.client,
      first.refresh_token!,
      undefined,
      new URL(`${BASE}/mcp`)
    );
    const authInfo = await h.provider.verifyAccessToken(second.access_token);
    expect(authInfo.extra?.cosenseSid).toBe(FRIEND_SID);

    // 2回続けてローテートしても壊れない（包み直しが1世代しか効かない実装を弾く）
    const third = await h.provider.exchangeRefreshToken(
      h.client,
      second.refresh_token!,
      undefined,
      new URL(`${BASE}/mcp`)
    );
    expect((await h.provider.verifyAccessToken(third.access_token)).extra?.cosenseSid).toBe(FRIEND_SID);
  });

  it('別の認可のトークンでは他人のSIDを開けない', async () => {
    const h = harness();
    const mine = await fullFlow(h, FRIEND_SID);
    const other = await fullFlow(h, 's%3AsomeoneElsesSession.zzz');

    expect((await h.provider.verifyAccessToken(mine.access_token)).extra?.cosenseSid).toBe(FRIEND_SID);
    expect((await h.provider.verifyAccessToken(other.access_token)).extra?.cosenseSid).toBe(
      's%3AsomeoneElsesSession.zzz'
    );
  });

  it('認可を取り消すと暗号文も消える', async () => {
    const h = harness();
    const tokens = await fullFlow(h, FRIEND_SID);
    expect(h.store.countSids()).toBe(1);

    await h.provider.revokeToken(h.client, { token: tokens.refresh_token! });
    expect(h.store.countSids()).toBe(0);
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('SIDを自分で入れる利用者は、空欄のまま承認できない', async () => {
    const h = harness();
    const pendingId = await beginConsent(h);
    expect(() => h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: '   ' }, '127.0.0.1')).toThrow(ConsentError);
    // 入力し直せば同じ pending のまま通る（行き止まりにしない）
    expect(() => h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID }, '127.0.0.1')).not.toThrow();
  });

  it('サーバー既定のSIDを使う利用者は空欄で通る', async () => {
    const h = harness();
    const pendingId = await beginConsent(h);
    // 環境変数のパスフレーズ側は sidSource='env'
    const redirect = h.provider.approve(pendingId, { passphrase: OWNER_PASSPHRASE, sid: '' }, '127.0.0.1');
    const tokens = await h.provider.exchangeAuthorizationCode(
      h.client,
      codeFrom(redirect),
      'verifier',
      REDIRECT_URI,
      new URL(`${BASE}/mcp`)
    );
    const authInfo = await h.provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.extra?.cosenseSid).toBeUndefined();
    expect(authInfo.extra?.userId).toBe('default');
  });

  it('打ち間違えて入力し直した場合は、あとから入れたSIDが採用される', async () => {
    const h = harness();
    const pendingId = await beginConsent(h);
    const first = codeFrom(h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: 'wrong-sid' }, '127.0.0.1'));
    const second = codeFrom(h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID }, '127.0.0.1'));
    // 同じ人の押し直しなので認可コードは冪等
    expect(second).toBe(first);

    const tokens = await h.provider.exchangeAuthorizationCode(
      h.client,
      second,
      'verifier',
      REDIRECT_URI,
      new URL(`${BASE}/mcp`)
    );
    expect((await h.provider.verifyAccessToken(tokens.access_token)).extra?.cosenseSid).toBe(FRIEND_SID);
  });
});

describe('sid-crypto', () => {
  it('違う秘密では開けない', () => {
    const dek = generateDek();
    const wrapped = wrapDek('token-aaa', dek);
    expect(() => unwrapDek('token-bbb', wrapped)).toThrow(SidDecryptError);
    expect(unwrapDek('token-aaa', wrapped).equals(dek)).toBe(true);
  });

  it('暗号文を改竄すると開けない（GCMの認証タグ）', () => {
    const dek = generateDek();
    const box = sealSid(dek, FRIEND_SID);
    const tampered = { ...box, ct: Buffer.from('tampered-value').toString('base64') };
    expect(() => unwrapDek('irrelevant', tampered)).toThrow(SidDecryptError);
  });
});
