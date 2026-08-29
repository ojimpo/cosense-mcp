/**
 * 稼働中のストアを読み続けられること。
 *
 * `sids` は後から足したフィールドで、本番の `/data/oauth-store.json` には無い。
 * ここで取りこぼすと、全クライアントが再登録・再認可になる（利用者から見ると
 * 「コネクタが突然切れた」）。デプロイして初めて気づく類なので、テストで固定する。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthStore, hashToken } from '../../auth/store.js';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function writeLegacyStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cosense-store-compat-'));
  const path = join(dir, 'oauth-store.json');
  // `sids` も `userId` も `wrappedDek` も無い、この変更より前の形
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      clients: {
        'client-abc': {
          client_id: 'client-abc',
          client_name: 'Claude',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        },
      },
      accessTokens: {
        [hashToken('legacy-access-token')]: {
          clientId: 'client-abc',
          scopes: ['mcp'],
          expiresAt: FUTURE,
          grantId: 'grant-1',
        },
      },
      refreshTokens: {
        [hashToken('legacy-refresh-token')]: {
          clientId: 'client-abc',
          scopes: ['mcp'],
          expiresAt: FUTURE,
          grantId: 'grant-1',
        },
      },
    })
  );
  return path;
}

describe('既存ストアとの互換性', () => {
  it('この変更より前のストアを、登録もトークンも落とさずに読める', () => {
    const path = writeLegacyStore();
    const store = new OAuthStore(path);

    expect(store.getClient('client-abc')?.client_name).toBe('Claude');
    expect(store.getAccessToken('legacy-access-token')).toMatchObject({
      clientId: 'client-abc',
      grantId: 'grant-1',
    });
    // 利用者IDが無いレコードでも消さない（既定の利用者として扱う側の責任）
    expect(store.getAccessToken('legacy-access-token')?.userId).toBeUndefined();
    expect(store.countSids()).toBe(0);
  });

  it('書き戻しても既存の登録とトークンは残る', () => {
    const path = writeLegacyStore();
    const store = new OAuthStore(path);
    store.saveSid('grant-1', { iv: 'aaa', ct: 'bbb', tag: 'ccc' });
    store.flush();

    const reloaded = JSON.parse(readFileSync(path, 'utf-8'));
    expect(reloaded.version).toBe(1);
    expect(Object.keys(reloaded.clients)).toEqual(['client-abc']);
    expect(Object.keys(reloaded.accessTokens)).toHaveLength(1);
    expect(reloaded.sids['grant-1']).toEqual({ iv: 'aaa', ct: 'bbb', tag: 'ccc' });
  });

  it('どのトークンからも辿れない暗号文は捨てる（読み込み時の掃除）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosense-store-orphan-'));
    const path = join(dir, 'oauth-store.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        clients: {},
        accessTokens: {},
        refreshTokens: {},
        sids: { 'grant-gone': { iv: 'a', ct: 'b', tag: 'c' } },
      })
    );
    // 鍵になるトークンが両方消えている以上、二度と開けない暗号文でしかない
    expect(new OAuthStore(path).countSids()).toBe(0);
  });
});
