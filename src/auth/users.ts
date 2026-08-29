/**
 * 利用者ディレクトリ。
 *
 * このサーバーは長らく「利用者は1人」を前提にしていて、認証はパスフレーズ1つだった。
 * 友人にも使ってもらうとなると、SID・触れるプロジェクト・破壊的ツールの可否を
 * 人ごとに分ける必要がある。その最小単位がこのファイル。
 *
 * 認証（誰か）はここ、認可（何ができるか）は各利用者のプロファイル、
 * SID の秘匿は別レイヤ（封筒暗号）と、役割を分けてある。パスフレーズは
 * SID の復号鍵には使わない — 鍵をパスフレーズ由来にすると、サーバーを再起動する
 * たびに全員に入力し直してもらうことになるため。
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { StoredUserRecord, UserStore } from './user-store.js';

/** scrypt のコスト。友人数人を総当たりする程度なら1回50ms前後で十分。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export class UserConfigError extends Error {}

/**
 * 1つのパスフレーズが複数の利用者に当たった。
 *
 * 黙って先頭を採ると、渡した相手が別人として振る舞う——しかも誰も気づかない。
 * 認証は落とす側に倒す。
 */
export class AmbiguousPassphraseError extends UserConfigError {}

export interface UserProfile {
  /** ログや監査に出る識別子。ファイル内で一意。 */
  id: string;
  /**
   * この利用者が触れる Cosense プロジェクト。先頭が既定プロジェクト。
   * 空なら「サーバー既定（環境変数）に従う」。
   */
  projects: string[];
  /** `delete_page` / `rewrite_page` をこの利用者に見せるか。 */
  enableDelete: boolean;
  /**
   * Cosense SID の出どころ。
   * - `consent`: 本人が同意画面で入力する。サーバー運用者は平文を保存しない
   * - `env`: サーバーの `COSENSE_SID` を使う（従来どおりの単独利用）
   */
  sidSource: 'consent' | 'env';
}

interface StoredUser {
  id?: unknown;
  passphrase?: unknown;
  passphraseHash?: unknown;
  projects?: unknown;
  enableDelete?: unknown;
  sidSource?: unknown;
}

interface StoredFile {
  version?: unknown;
  users?: unknown;
}

/** パスフレーズを `scrypt$<salt-b64>$<hash-b64>` 形式にする。users.json を手で書く人向け。 */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyHashed(candidate: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1]!, 'base64');
    expected = Buffer.from(parts[2]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(candidate, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return timingSafeEqual(expected, actual);
}

function verifyPlain(candidate: string, expected: string): boolean {
  // 長さの違いで分岐しないよう、固定長のダイジェスト同士を比べる。
  const a = scryptSync(candidate, 'plain-compare', SCRYPT_KEYLEN, { N: 1024, r: SCRYPT_R, p: SCRYPT_P });
  const b = scryptSync(expected, 'plain-compare', SCRYPT_KEYLEN, { N: 1024, r: SCRYPT_R, p: SCRYPT_P });
  return timingSafeEqual(a, b);
}

/**
 * 同じパスフレーズを2人に配っていないか、起動時に見える範囲で確かめる。
 *
 * 見抜けるのは (1) 同じ文字列がそのまま2つある（平文の重複、ハッシュ行のコピペ）、
 * (2) 片方が平文でもう片方がそのハッシュ、の2つ。
 * **別々のソルトでハッシュ化された同一パスフレーズは、ここでは検出できない**
 * （それが scrypt の目的なので）。最後の網は `authenticate` 側に置いてある。
 */
function assertDistinctPassphrases(entries: Entry[]): void {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      const duplicate =
        a.secret === b.secret ||
        (!a.hashed && b.hashed && verifyHashed(a.secret, b.secret)) ||
        (!b.hashed && a.hashed && verifyHashed(b.secret, a.secret));
      if (duplicate) {
        throw new UserConfigError(
          `users '${a.profile.id}' and '${b.profile.id}' share a passphrase; give each user their own`
        );
      }
    }
  }
}

interface Entry {
  profile: UserProfile;
  /** `scrypt$...` 形式なら true。false なら平文比較。 */
  hashed: boolean;
  secret: string;
}

export class UserDirectory {
  private constructor(
    /** 起動時に確定する利用者（環境変数の運用者と `users.json`）。 */
    private readonly staticEntries: Entry[],
    /** 招待から登録された利用者。再起動を挟まずに増減するので、都度読む。 */
    private readonly store?: UserStore
  ) {}

  /** 実行時に増減する保存先を繋ぐ。静的な設定はそのまま残る。 */
  withStore(store: UserStore): UserDirectory {
    return new UserDirectory(this.staticEntries, store);
  }

  /**
   * 静的な設定と保存先を合わせた全件。静的側を先に置く——
   * 運用者を保存先のレコードで上書きできてしまうと、招待経由で乗っ取れることになる。
   */
  private get entries(): Entry[] {
    const dynamic = (this.store?.list() ?? [])
      .filter((record) => !this.staticEntries.some((entry) => entry.profile.id === record.id))
      .map(storedToEntry);
    return [...this.staticEntries, ...dynamic];
  }

  /** 従来どおりの単独利用。環境変数のパスフレーズを持つ利用者が1人だけいる状態。 */
  static single(passphrase: string, options: { enableDelete: boolean }): UserDirectory {
    return new UserDirectory([
      {
        profile: { id: 'default', projects: [], enableDelete: options.enableDelete, sidSource: 'env' },
        hashed: false,
        secret: passphrase,
      },
    ]);
  }

  /**
   * users.json を読む。
   *
   * 壊れたファイルで黙って「認証できない状態」になるより、起動を止めるほうがよい。
   * 認証まわりの設定ミスは、気づかないまま公開されるのが一番まずい。
   */
  static fromFile(filePath: string, fallback: UserDirectory): UserDirectory {
    if (!existsSync(filePath)) {
      throw new UserConfigError(`MCP_USERS_FILE points at a file that does not exist: ${filePath}`);
    }
    let parsed: StoredFile;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as StoredFile;
    } catch (error) {
      throw new UserConfigError(`MCP_USERS_FILE is not valid JSON: ${String(error)}`);
    }
    if (parsed.version !== 1) {
      throw new UserConfigError(`MCP_USERS_FILE has an unsupported version: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.users) || parsed.users.length === 0) {
      throw new UserConfigError('MCP_USERS_FILE must contain a non-empty "users" array');
    }

    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.users as StoredUser[]) {
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id) throw new UserConfigError('every user in MCP_USERS_FILE needs a non-empty "id"');
      if (seen.has(id)) throw new UserConfigError(`duplicate user id in MCP_USERS_FILE: ${id}`);
      seen.add(id);

      const hashedSecret = typeof raw.passphraseHash === 'string' ? raw.passphraseHash : undefined;
      const plainSecret = typeof raw.passphrase === 'string' ? raw.passphrase : undefined;
      if (!hashedSecret && !plainSecret) {
        throw new UserConfigError(`user '${id}' needs either "passphraseHash" or "passphrase"`);
      }
      if (plainSecret && plainSecret.length < 12) {
        throw new UserConfigError(`user '${id}' has a passphrase shorter than 12 characters`);
      }
      if (plainSecret && !hashedSecret) {
        console.error(`[users] '${id}' stores a plaintext passphrase; run hashPassphrase() and use "passphraseHash"`);
      }

      const projects = Array.isArray(raw.projects)
        ? raw.projects.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map((n) => n.trim())
        : [];
      const sidSource = raw.sidSource === 'env' ? 'env' : 'consent';

      entries.push({
        profile: { id, projects, enableDelete: raw.enableDelete === true, sidSource },
        hashed: hashedSecret !== undefined,
        secret: hashedSecret ?? plainSecret!,
      });
    }

    // 環境変数のパスフレーズは、users.json があっても「運用者本人」として残す。
    // これが無いと、users.json を壊した瞬間に自分も締め出される。
    for (const entry of fallback.entries) {
      if (!seen.has(entry.profile.id)) entries.push(entry);
    }
    assertDistinctPassphrases(entries);
    return new UserDirectory(entries);
  }

  /**
   * パスフレーズから利用者を引く。一致しなければ undefined。
   *
   * 複数に当たったら例外。起動時のチェックはソルト違いの同一パスフレーズを見抜けない
   * （scrypt はソルトが違えば別のハッシュになる）ので、最後の網はここに要る。
   */
  authenticate(passphrase: string): UserProfile | undefined {
    const matches: UserProfile[] = [];
    for (const entry of this.entries) {
      // 見つかっても全件回す。ループを抜ける位置で「何人目か」が漏れないようにする。
      const ok = entry.hashed ? verifyHashed(passphrase, entry.secret) : verifyPlain(passphrase, entry.secret);
      if (ok) matches.push(entry.profile);
    }
    if (matches.length > 1) {
      throw new AmbiguousPassphraseError(
        `passphrase matches multiple users: ${matches.map((m) => m.id).join(', ')}`
      );
    }
    return matches[0];
  }

  /** 利用者IDからプロファイルを引く（トークンに焼かれたIDを解決するため）。 */
  get(id: string): UserProfile | undefined {
    return this.entries.find((entry) => entry.profile.id === id)?.profile;
  }

  /**
   * そのパスフレーズが既に誰かのものになっていないか。
   * 登録時に呼ぶ。`authenticate` は複数一致で例外を投げるので、そのまま使えない。
   */
  isPassphraseTaken(passphrase: string): boolean {
    try {
      return this.authenticate(passphrase) !== undefined;
    } catch {
      // 複数一致＝当然「使われている」
      return true;
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get ids(): string[] {
    return this.entries.map((entry) => entry.profile.id);
  }

  /** 管理画面に出す一覧。パスフレーズもSIDも含まない。 */
  describe(): Array<{
    id: string;
    source: 'static' | 'enrolled';
    projects: string[];
    enableDelete: boolean;
    sidSource: 'consent' | 'env';
    createdAt?: number;
    lastSeenAt?: number;
    inviteId?: string;
  }> {
    const stored = new Map((this.store?.list() ?? []).map((record) => [record.id, record]));
    return this.entries.map((entry) => {
      const record = stored.get(entry.profile.id);
      const isStatic = this.isStatic(entry.profile.id);
      return {
        id: entry.profile.id,
        source: isStatic ? ('static' as const) : ('enrolled' as const),
        projects: entry.profile.projects,
        enableDelete: entry.profile.enableDelete,
        sidSource: entry.profile.sidSource,
        ...(record?.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
        ...(record?.lastSeenAt !== undefined ? { lastSeenAt: record.lastSeenAt } : {}),
        ...(record?.inviteId !== undefined ? { inviteId: record.inviteId } : {}),
      };
    });
  }

  /** 静的な設定に居る利用者か（保存先から消せない＝招待では触れない）。 */
  isStatic(id: string): boolean {
    return this.staticEntries.some((entry) => entry.profile.id === id);
  }

  /**
   * 保存先に利用者を足す。
   *
   * パスフレーズが既存の誰かと当たる場合は断る。ここを通すと、登録した本人が
   * 別人として振る舞う（あるいは `authenticate` が例外を投げて両方入れなくなる）。
   */
  addUser(record: StoredUserRecord): void {
    if (!this.store) throw new UserConfigError('No writable user store is configured');
    if (this.entries.some((entry) => entry.profile.id === record.id)) {
      throw new UserConfigError(`User '${record.id}' already exists`);
    }
    this.store.add(record);
  }

  /** 保存先から利用者を消す。静的な設定の利用者は消せない。 */
  removeUser(id: string): boolean {
    if (!this.store) return false;
    if (this.isStatic(id)) return false;
    return this.store.remove(id);
  }

  /** 最終利用時刻を進める。運用者が「使われているか」を見るためだけの値。 */
  touch(id: string): void {
    this.store?.touch(id);
  }
}

function storedToEntry(record: StoredUserRecord): Entry {
  return {
    profile: {
      id: record.id,
      projects: record.projects,
      enableDelete: record.enableDelete,
      sidSource: record.sidSource,
    },
    hashed: true,
    secret: record.passphraseHash,
  };
}
