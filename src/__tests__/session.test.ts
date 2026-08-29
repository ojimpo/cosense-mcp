/**
 * 接続ごとの設定解決。
 *
 * ここを間違えると「他人の SID で書けた」「許可していないプロジェクトに届いた」に
 * 直結するので、既定へのフォールバックが起きる条件を明示的に固定しておく。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserDirectory } from '../auth/users.js';
import {
  defaultSession,
  describeProjectName,
  resolveSessionConfig,
  type SessionDefaults,
} from '../session.js';

const DEFAULTS: SessionDefaults = {
  projectName: 'kouki',
  cosenseSid: 'owner-sid',
  allowedProjects: ['kouki', 'nbca-kit'],
  enableDelete: true,
};

function directory(users: unknown[]): UserDirectory {
  const dir = mkdtempSync(join(tmpdir(), 'cosense-session-'));
  const path = join(dir, 'users.json');
  writeFileSync(path, JSON.stringify({ version: 1, users }));
  return UserDirectory.fromFile(path, UserDirectory.single('owner-passphrase-1234', { enableDelete: true }));
}

const FRIEND = { id: 'friend', passphrase: 'friend-passphrase-99', projects: ['shared'], enableDelete: false };

describe('resolveSessionConfig', () => {
  it('利用者が特定できなければ既定に落ちる（stdio・従来構成のための道）', () => {
    expect(resolveSessionConfig(undefined, undefined, DEFAULTS)).toEqual(defaultSession(DEFAULTS));
    // トークンに利用者IDはあるが users.json に居ない場合も同じ
    const users = directory([FRIEND]);
    expect(resolveSessionConfig({ extra: { userId: 'ghost' } }, users, DEFAULTS).userId).toBe('default');
  });

  it('友人の接続には、本人が入力したSIDだけを渡す', () => {
    const users = directory([FRIEND]);
    const session = resolveSessionConfig(
      { extra: { userId: 'friend', cosenseSid: 'friend-sid' } },
      users,
      DEFAULTS
    );
    expect(session.cosenseSid).toBe('friend-sid');
    expect(session.projectName).toBe('shared');
    expect(session.allowedProjects).toEqual(['shared']);
    expect(session.enableDelete).toBe(false);
    expect(session.isDefaultSession).toBe(false);
  });

  it('SIDが復号できなかった友人には、サーバーのSIDを渡さない', () => {
    const users = directory([FRIEND]);
    const session = resolveSessionConfig({ extra: { userId: 'friend' } }, users, DEFAULTS);
    // 「SIDが無くて書けない」で止まるのが正しい。既定に落ちると運用者の権限で書けてしまう
    expect(session.cosenseSid).toBeUndefined();
    expect(session.allowedProjects).toEqual(['shared']);
  });

  it('サーバーのSIDを使う利用者でも、プロジェクトを絞れば既定セッション扱いにしない', () => {
    const users = directory([
      { id: 'reader', passphrase: 'reader-passphrase-99', projects: ['shared'], sidSource: 'env' },
    ]);
    const session = resolveSessionConfig({ extra: { userId: 'reader' } }, users, DEFAULTS);
    expect(session.cosenseSid).toBe('owner-sid');
    expect(session.allowedProjects).toEqual(['shared']);
    // 起動時に既定プロジェクトから取った resources を、この接続へ出してはいけない
    expect(session.isDefaultSession).toBe(false);
  });

  it('環境変数の運用者はサーバー既定そのまま', () => {
    const users = directory([FRIEND]);
    const session = resolveSessionConfig({ extra: { userId: 'default' } }, users, DEFAULTS);
    expect(session).toEqual({ ...defaultSession(DEFAULTS), userId: 'default' });
    expect(session.allowedProjects).toEqual(['kouki', 'nbca-kit']);
  });
});

describe('describeProjectName', () => {
  it('許可リストが無ければ既定プロジェクトだけを案内する', () => {
    const session = defaultSession({ ...DEFAULTS, allowedProjects: undefined });
    expect(describeProjectName(session)).toBe("Target project name. If not specified, defaults to 'kouki'.");
  });

  it('許可リストは候補として列挙する（柵であると同時にメニューなので）', () => {
    const description = describeProjectName(defaultSession(DEFAULTS));
    expect(description).toContain('kouki, nbca-kit');
  });

  it('友人の接続には、その人に許したプロジェクトしか出さない', () => {
    const users = directory([FRIEND]);
    const session = resolveSessionConfig({ extra: { userId: 'friend' } }, users, DEFAULTS);
    const description = describeProjectName(session);
    // ここが固定のままだと、友人のクライアントに運用者のプロジェクト名が並ぶ
    expect(description).toContain('shared');
    expect(description).not.toContain('nbca-kit');
    expect(description).not.toContain('kouki');
  });
});
