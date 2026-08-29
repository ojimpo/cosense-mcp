/**
 * 実行時に増減する利用者。
 *
 * 静的な設定（環境変数の運用者と users.json）と保存先が合成されるので、
 * どちらが勝つかを取り違えると、招待経由で運用者を上書きできることになる。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigError, UserDirectory, hashPassphrase } from '../../auth/users.js';
import { UserStore, type StoredUserRecord } from '../../auth/user-store.js';

const OWNER_PASSPHRASE = 'owner-passphrase-1234';

function tempPath(name = 'users-store.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'cosense-user-store-')), name);
}

function owner(): UserDirectory {
  return UserDirectory.single(OWNER_PASSPHRASE, { enableDelete: true });
}

function record(overrides: Partial<StoredUserRecord> = {}): StoredUserRecord {
  return {
    id: 'friend',
    passphraseHash: hashPassphrase('friend-passphrase-99'),
    projects: ['shared'],
    enableDelete: false,
    sidSource: 'consent',
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('UserStore', () => {
  it('登録した利用者はファイルに残り、読み直しても引ける', () => {
    const path = tempPath();
    const store = new UserStore(path);
    store.add(record());
    store.flush();

    expect(new UserStore(path).get('friend')?.projects).toEqual(['shared']);
  });

  it('SIDを置ける場所がそもそも無い（保存されるフィールドを固定する）', () => {
    const path = tempPath();
    const store = new UserStore(path);
    store.add(record());
    store.flush();

    // 「誰が登録しているかは見えるが、その人のSIDは見えない」を保つ要。
    // 将来ここに SID を持たせようとしたら、このテストが落ちる
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Object.keys(parsed.users.friend).sort()).toEqual(
      ['createdAt', 'enableDelete', 'id', 'passphraseHash', 'projects', 'sidSource'].sort()
    );
    // 平文のパスフレーズも残さない
    expect(readFileSync(path, 'utf-8')).not.toContain('friend-passphrase-99');
  });

  it('壊れたファイルでは起動を止める（空で続けると全員が締め出される）', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json');
    expect(() => new UserStore(path)).toThrow(/Failed to read the user store/);

    const wrongVersion = tempPath();
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, users: {} }));
    expect(() => new UserStore(wrongVersion)).toThrow(/unsupported version/);
  });

  it('最終利用時刻の更新は間引く', () => {
    const store = new UserStore();
    store.add(record());
    store.touch('friend');
    const first = store.get('friend')?.lastSeenAt;
    expect(first).toBeDefined();

    store.touch('friend');
    // 同じ分解能の中では書き換えない（読み取りだけの利用でディスクを鳴らさない）
    expect(store.get('friend')?.lastSeenAt).toBe(first);
  });
});

describe('UserDirectory + UserStore', () => {
  it('保存先の利用者も認証できる', () => {
    const store = new UserStore();
    store.add(record());
    const directory = owner().withStore(store);

    expect(directory.authenticate('friend-passphrase-99')?.id).toBe('friend');
    expect(directory.authenticate(OWNER_PASSPHRASE)?.id).toBe('default');
    expect(directory.size).toBe(2);
  });

  it('保存先のレコードで静的な利用者を上書きできない', () => {
    const store = new UserStore();
    // 招待経由で運用者を名乗れてしまうと、そこから全部を取れる
    store.add(record({ id: 'default', passphraseHash: hashPassphrase('hijack-passphrase-9') }));
    const directory = owner().withStore(store);

    expect(directory.size).toBe(1);
    expect(directory.authenticate(OWNER_PASSPHRASE)?.id).toBe('default');
    expect(directory.authenticate('hijack-passphrase-9')).toBeUndefined();
  });

  it('既存のIDでは登録できない', () => {
    const directory = owner().withStore(new UserStore());
    directory.addUser(record());
    expect(() => directory.addUser(record())).toThrow(UserConfigError);
    expect(() => directory.addUser(record({ id: 'default' }))).toThrow(/already exists/);
  });

  it('静的な設定の利用者は消せない', () => {
    const store = new UserStore();
    store.add(record());
    const directory = owner().withStore(store);

    expect(directory.removeUser('default')).toBe(false);
    expect(directory.authenticate(OWNER_PASSPHRASE)).toBeDefined();

    expect(directory.removeUser('friend')).toBe(true);
    expect(directory.authenticate('friend-passphrase-99')).toBeUndefined();
  });

  it('使われているパスフレーズかを、複数一致でも落ちずに判定できる', () => {
    const store = new UserStore();
    store.add(record({ id: 'a', passphraseHash: hashPassphrase('shared-passphrase-99') }));
    store.add(record({ id: 'b', passphraseHash: hashPassphrase('shared-passphrase-99') }));
    const directory = owner().withStore(store);

    // authenticate は例外を投げるが、登録時の判定は真偽値で答える必要がある
    expect(directory.isPassphraseTaken('shared-passphrase-99')).toBe(true);
    expect(directory.isPassphraseTaken('nobody-uses-this-99')).toBe(false);
  });

  it('保存先が無ければ登録は断る', () => {
    expect(() => owner().addUser(record())).toThrow(/No writable user store/);
  });
});
