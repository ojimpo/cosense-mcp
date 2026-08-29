/**
 * 招待からの登録。
 *
 * 同意画面はコネクタを登録する（あるいは再認可する）ときにしか出ないので、
 * ここが友人にとって唯一の入口になる。行き止まりを作らないことと、
 * 中途半端な状態の利用者を作らないことを中心に固定する。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { resolveOAuthConfig } from '../../auth/config.js';
import { OAuthStore } from '../../auth/store.js';
import { ConsentError, CosenseOAuthProvider } from '../../auth/provider.js';
import { renderConsentPage } from '../../auth/pages.js';

const OWNER_PASSPHRASE = 'owner-passphrase-1234';
const FRIEND_PASSPHRASE = 'friend-passphrase-99';
const FRIEND_SID = 's%3AfriendSession.abcdef';
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

function harness(options: { invites?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cosense-enroll-'));
  const config = resolveOAuthConfig({
    MCP_PUBLIC_URL: BASE,
    MCP_OAUTH_PASSPHRASE: OWNER_PASSPHRASE,
    ...(options.invites === false ? {} : { MCP_USERS_STORE: join(dir, 'users-store.json') }),
  })!;
  const provider = new CosenseOAuthProvider(config, new OAuthStore(), '/oauth/consent', renderConsentPage);
  const client = provider.clientsStore.registerClient!({
    client_id: 'test-client',
    redirect_uris: [REDIRECT_URI],
  } as OAuthClientInformationFull) as OAuthClientInformationFull;
  return { config, provider, client };
}

async function beginConsent(h: ReturnType<typeof harness>): Promise<string> {
  const res = fakeResponse();
  await h.provider.authorize(
    h.client,
    { redirectUri: REDIRECT_URI, codeChallenge: 'challenge', scopes: ['mcp'], resource: new URL(`${BASE}/mcp`) },
    res
  );
  return /name="pending_id" value="([^"]+)"/.exec(res.body)![1]!;
}

describe('招待からの登録', () => {
  it('合言葉・パスフレーズ・SIDが揃えば、その場で登録されて認可も通る', async () => {
    const h = harness();
    const { code } = h.config.invites!.create({ userId: 'friend', projects: ['shared'], enableDelete: false });
    const pendingId = await beginConsent(h);

    const redirect = h.provider.approve(
      pendingId,
      { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: code },
      '127.0.0.1'
    );
    // 同意画面を2回通らせない（登録と認可を同じ送信で終わらせる）
    expect(new URL(redirect).searchParams.get('code')).toBeTruthy();

    const profile = h.config.users.get('friend')!;
    expect(profile.projects).toEqual(['shared']);
    expect(profile.enableDelete).toBe(false);
    expect(profile.sidSource).toBe('consent');

    // 以後は自分で決めたパスフレーズで認証できる
    expect(h.config.users.authenticate(FRIEND_PASSPHRASE)?.id).toBe('friend');
  });

  it('合言葉は使い捨て。2人目は同じもので登録できない', async () => {
    const h = harness();
    const { code } = h.config.invites!.create({ userId: 'friend', projects: [], enableDelete: false });

    h.provider.approve(
      await beginConsent(h),
      { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: code },
      '127.0.0.1'
    );

    const second = await beginConsent(h);
    expect(() =>
      h.provider.approve(second, { passphrase: 'another-passphrase-9', sid: FRIEND_SID, inviteCode: code }, '127.0.0.2')
    ).toThrow(/not valid, has expired, or has already been used/);
  });

  it('入力が足りなければ登録せず、合言葉も消費しない', async () => {
    const h = harness();
    const { code, invite } = h.config.invites!.create({ userId: 'friend', projects: [], enableDelete: false });
    const pendingId = await beginConsent(h);

    const submit = (patch: Record<string, string>) =>
      h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: code, ...patch }, '127.0.0.1');

    expect(() => submit({ passphrase: 'short' })).toThrow(/at least 12 characters/);
    expect(() => submit({ sid: '' })).toThrow(/Paste your own Cosense SID/);
    expect(() => submit({ passphrase: OWNER_PASSPHRASE })).toThrow(/already in use/);

    // 3回失敗しても招待は生きていて、利用者もできていない
    expect(h.config.users.get('friend')).toBeUndefined();
    expect(h.config.invites!.find(code)?.id).toBe(invite.id);
    expect(() => submit({})).not.toThrow();
  });

  it('存在しない合言葉では登録できない', async () => {
    const h = harness();
    const pendingId = await beginConsent(h);
    expect(() =>
      h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: 'aaa-bbb-ccc' }, '127.0.0.1')
    ).toThrow(ConsentError);
    expect(h.config.users.size).toBe(1);
  });

  it('招待を受け付けないサーバーでは、欄も出さず受け付けもしない', async () => {
    const h = harness({ invites: false });
    expect(h.config.invites).toBeUndefined();

    const res = fakeResponse();
    await h.provider.authorize(
      h.client,
      { redirectUri: REDIRECT_URI, codeChallenge: 'c', scopes: ['mcp'], resource: new URL(`${BASE}/mcp`) },
      res
    );
    expect(res.body).not.toContain('invite_code');

    const pendingId = /name="pending_id" value="([^"]+)"/.exec(res.body)![1]!;
    expect(() =>
      h.provider.approve(pendingId, { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: 'aaa-bbb-ccc' }, '127.0.0.1')
    ).toThrow(/does not accept invite codes/);
  });

  it('登録した利用者は、運用者の権限を継承しない', async () => {
    const h = harness();
    const { code } = h.config.invites!.create({ userId: 'friend', projects: ['shared'], enableDelete: false });
    h.provider.approve(
      await beginConsent(h),
      { passphrase: FRIEND_PASSPHRASE, sid: FRIEND_SID, inviteCode: code },
      '127.0.0.1'
    );

    const friend = h.config.users.get('friend')!;
    const owner = h.config.users.get('default')!;
    expect(friend.enableDelete).toBe(false);
    expect(owner.enableDelete).toBe(false); // COSENSE_ENABLE_DELETE 未設定の env なので
    expect(friend.projects).toEqual(['shared']);
    expect(owner.projects).toEqual([]);
  });
});
