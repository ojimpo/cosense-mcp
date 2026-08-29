/**
 * 利用者ディレクトリ。認証（誰か）と認可（何ができるか）の分かれ目なので、
 * 設定ファイルの壊れ方を黙って飲み込まないことを中心に確認する。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AmbiguousPassphraseError,
  UserConfigError,
  UserDirectory,
  hashPassphrase,
} from '../../auth/users.js';

const OWNER_PASSPHRASE = 'owner-passphrase-1234';

function owner(): UserDirectory {
  return UserDirectory.single(OWNER_PASSPHRASE, { enableDelete: true });
}

function writeUsers(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cosense-users-'));
  const path = join(dir, 'users.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('UserDirectory', () => {
  it('環境変数のパスフレーズだけでも1人の利用者として引ける', () => {
    const directory = owner();
    expect(directory.size).toBe(1);
    expect(directory.authenticate(OWNER_PASSPHRASE)?.id).toBe('default');
    expect(directory.authenticate('wrong-passphrase')).toBeUndefined();
    expect(directory.authenticate(OWNER_PASSPHRASE)?.sidSource).toBe('env');
  });

  it('scryptハッシュでパスフレーズを検証できる', () => {
    const path = writeUsers({
      version: 1,
      users: [{ id: 'friend', passphraseHash: hashPassphrase('friend-passphrase-99'), projects: ['shared'] }],
    });
    const directory = UserDirectory.fromFile(path, owner());
    expect(directory.authenticate('friend-passphrase-99')?.id).toBe('friend');
    expect(directory.authenticate('friend-passphrase-98')).toBeUndefined();
  });

  it('利用者ごとに許可プロジェクトと破壊的ツールの可否を分けられる', () => {
    const path = writeUsers({
      version: 1,
      users: [
        { id: 'friend', passphrase: 'friend-passphrase-99', projects: ['shared'], enableDelete: false },
        { id: 'trusted', passphrase: 'trusted-passphrase-9', projects: ['shared', 'notes'], enableDelete: true },
      ],
    });
    const directory = UserDirectory.fromFile(path, owner());

    const friend = directory.authenticate('friend-passphrase-99')!;
    expect(friend.projects).toEqual(['shared']);
    expect(friend.enableDelete).toBe(false);
    // 既定は本人入力。運用者が SID を預からない側に倒す。
    expect(friend.sidSource).toBe('consent');

    const trusted = directory.authenticate('trusted-passphrase-9')!;
    expect(trusted.projects).toEqual(['shared', 'notes']);
    expect(trusted.enableDelete).toBe(true);
  });

  it('users.json があっても環境変数の運用者は残る', () => {
    const path = writeUsers({ version: 1, users: [{ id: 'friend', passphrase: 'friend-passphrase-99' }] });
    const directory = UserDirectory.fromFile(path, owner());
    // これが消えると、users.json を壊したときに自分も締め出されて直せなくなる
    expect(directory.authenticate(OWNER_PASSPHRASE)?.id).toBe('default');
    expect(directory.ids).toEqual(['friend', 'default']);
  });

  it('users.json 側が default を名乗ったらそちらが勝つ（重複を作らない）', () => {
    const path = writeUsers({
      version: 1,
      users: [{ id: 'default', passphrase: 'explicit-default-99', projects: ['mine'] }],
    });
    const directory = UserDirectory.fromFile(path, owner());
    expect(directory.size).toBe(1);
    expect(directory.authenticate('explicit-default-99')?.projects).toEqual(['mine']);
    expect(directory.authenticate(OWNER_PASSPHRASE)).toBeUndefined();
  });

  it('同じパスフレーズを2人に配っていたら起動を止める', () => {
    // 平文どうし
    const plain = writeUsers({
      version: 1,
      users: [
        { id: 'a', passphrase: 'shared-passphrase-99' },
        { id: 'b', passphrase: 'shared-passphrase-99' },
      ],
    });
    expect(() => UserDirectory.fromFile(plain, owner())).toThrow(/share a passphrase/);

    // 片方が平文、もう片方がそのハッシュ
    const mixed = writeUsers({
      version: 1,
      users: [
        { id: 'a', passphrase: 'shared-passphrase-99' },
        { id: 'b', passphraseHash: hashPassphrase('shared-passphrase-99') },
      ],
    });
    expect(() => UserDirectory.fromFile(mixed, owner())).toThrow(/share a passphrase/);

    // ハッシュ行をコピペした場合
    const sameHash = hashPassphrase('shared-passphrase-99');
    const copied = writeUsers({
      version: 1,
      users: [
        { id: 'a', passphraseHash: sameHash },
        { id: 'b', passphraseHash: sameHash },
      ],
    });
    expect(() => UserDirectory.fromFile(copied, owner())).toThrow(/share a passphrase/);

    // 環境変数の運用者と同じものを配ってしまった場合
    const asOwner = writeUsers({ version: 1, users: [{ id: 'a', passphrase: OWNER_PASSPHRASE }] });
    expect(() => UserDirectory.fromFile(asOwner, owner())).toThrow(/share a passphrase/);
  });

  it('別々にハッシュ化された同一パスフレーズは、認証の時点で撥ねる', () => {
    // scrypt はソルトが違えば別のハッシュになるので、起動時には見抜けない。
    // ここを素通りさせると、渡した相手が黙って別人として振る舞う
    const path = writeUsers({
      version: 1,
      users: [
        { id: 'a', passphraseHash: hashPassphrase('shared-passphrase-99') },
        { id: 'b', passphraseHash: hashPassphrase('shared-passphrase-99') },
      ],
    });
    const directory = UserDirectory.fromFile(path, owner());
    expect(directory.size).toBe(3);
    expect(() => directory.authenticate('shared-passphrase-99')).toThrow(AmbiguousPassphraseError);
    // 他の利用者の認証は巻き添えにしない
    expect(directory.authenticate(OWNER_PASSPHRASE)?.id).toBe('default');
  });

  it('壊れた設定は黙って無視せず起動を止める', () => {
    expect(() => UserDirectory.fromFile('/nonexistent/users.json', owner())).toThrow(UserConfigError);

    const badVersion = writeUsers({ version: 2, users: [] });
    expect(() => UserDirectory.fromFile(badVersion, owner())).toThrow(/unsupported version/);

    const empty = writeUsers({ version: 1, users: [] });
    expect(() => UserDirectory.fromFile(empty, owner())).toThrow(/non-empty/);

    const noId = writeUsers({ version: 1, users: [{ passphrase: 'friend-passphrase-99' }] });
    expect(() => UserDirectory.fromFile(noId, owner())).toThrow(/"id"/);

    const noSecret = writeUsers({ version: 1, users: [{ id: 'friend' }] });
    expect(() => UserDirectory.fromFile(noSecret, owner())).toThrow(/passphraseHash/);

    const shortSecret = writeUsers({ version: 1, users: [{ id: 'friend', passphrase: 'short' }] });
    expect(() => UserDirectory.fromFile(shortSecret, owner())).toThrow(/shorter than 12/);

    const dup = writeUsers({
      version: 1,
      users: [
        { id: 'friend', passphrase: 'friend-passphrase-99' },
        { id: 'friend', passphrase: 'friend-passphrase-98' },
      ],
    });
    expect(() => UserDirectory.fromFile(dup, owner())).toThrow(/duplicate user id/);
  });
});
