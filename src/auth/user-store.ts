/**
 * 実行時に増減する利用者の保存先。
 *
 * `users.json`（`MCP_USERS_FILE`）は起動時に1回読むだけの静的な設定で、運用者が
 * 手で書く前提のもの。招待から自分で登録してもらう以上、サーバー自身が書き足せる
 * 置き場が別に要る。トークンとは寿命が違う（トークンを全部消しても利用者は残る）ので
 * ファイルも分ける。
 *
 * **ここに SID は入らない。** SID の暗号文はグラント単位で `OAuthStore` 側にあり、
 * 復号鍵はアクセストークンからしか作れない。つまりこのファイルを見ても、
 * 誰が登録しているかは分かるが、その人の SID は分からない。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredUserRecord {
  id: string;
  /** `scrypt$<salt>$<hash>`。平文は保存しない。 */
  passphraseHash: string;
  projects: string[];
  enableDelete: boolean;
  sidSource: 'consent' | 'env';
  /** 秒精度の UNIX 時刻。 */
  createdAt: number;
  /** どの招待から登録したか。誰が誰を呼んだのかを後から辿れるようにする。 */
  inviteId?: string;
  /** 最後にトークンが使われた時刻。「使っているか」を運用者が見るためだけの値。 */
  lastSeenAt?: number;
}

interface StoreData {
  version: 1;
  users: Record<string, StoredUserRecord>;
}

function emptyData(): StoreData {
  return { version: 1, users: {} };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** `lastSeenAt` の更新間隔。リクエストごとに書くと、読み取りだけの利用でもディスクが鳴り続ける。 */
const LAST_SEEN_RESOLUTION_SEC = 60;

export class UserStore {
  private data: StoreData = emptyData();
  private readonly filePath: string | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<StoreData>;
      if (parsed.version !== 1) {
        // 利用者が消えると全員が入れなくなる。黙って空で始めず、気づける形にする。
        throw new Error(`unsupported version: ${String(parsed.version)}`);
      }
      this.data = { version: 1, users: parsed.users ?? {} };
    } catch (error) {
      // ここで空にして起動を続けると、登録済みの全員が締め出されたまま動き続ける。
      throw new Error(`Failed to read the user store at ${this.filePath}: ${String(error)}`);
    }
  }

  private schedulePersist(): void {
    if (!this.filePath) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 50);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  list(): StoredUserRecord[] {
    return Object.values(this.data.users).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): StoredUserRecord | undefined {
    return this.data.users[id];
  }

  has(id: string): boolean {
    return id in this.data.users;
  }

  add(record: StoredUserRecord): void {
    this.data.users[record.id] = record;
    this.schedulePersist();
    this.flush();
  }

  remove(id: string): boolean {
    if (!(id in this.data.users)) return false;
    delete this.data.users[id];
    this.flush();
    return true;
  }

  /** 最終利用時刻を進める。分解能を落として書き込みを間引く。 */
  touch(id: string): void {
    const record = this.data.users[id];
    if (!record) return;
    const now = nowSec();
    if (record.lastSeenAt !== undefined && now - record.lastSeenAt < LAST_SEEN_RESOLUTION_SEC) return;
    record.lastSeenAt = now;
    this.schedulePersist();
  }

  get size(): number {
    return Object.keys(this.data.users).length;
  }
}
