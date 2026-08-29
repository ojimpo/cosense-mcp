/**
 * 招待。
 *
 * 利用者を1人増やすのに「JSONを編集して再起動」を要求すると、運用者しか動けず、
 * 人が増えるたびに手が止まる。招待は**権限を先に確定させた使い捨ての合言葉**で、
 * 受け取った本人が自分でパスフレーズとSIDを入れて登録を完了する。
 *
 * 合言葉が「短くてよい」根拠は3つ:
 *
 * - 使い捨て（1回消費したら消える）
 * - 期限付き（既定24時間）
 * - 同意画面のレート制限（IPあたり15分10回）が総当たりを潰す
 *
 * それでも45ビット持たせてあるのは、レート制限がIP単位でしかないため。
 * 分散して叩かれる前提でも、期限内に当てるのは現実的でない。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

/** 読み違えの起きる字（0/O/1/l/I）を落とした字母。 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const BLOCK_LENGTH = 3;
const BLOCK_COUNT = 3;

/** 招待の既定の有効期間（秒）。渡してから入力されるまでの現実的な間。 */
export const DEFAULT_INVITE_TTL_SEC = 24 * 60 * 60;

export class InviteError extends Error {}

export interface InviteRecord {
  /** ログと監査に出るID。合言葉そのものではない。 */
  id: string;
  /** 合言葉のSHA-256。平文は発行時に一度返すだけで保存しない。 */
  codeHash: string;
  /** 登録される利用者のID。運用者が「誰向けか」を決める。 */
  userId: string;
  projects: string[];
  enableDelete: boolean;
  createdAt: number;
  expiresAt: number;
  /** 消費済みなら、その時刻。記録として残す（誰がいつ入ったかを辿るため）。 */
  usedAt?: number;
}

interface StoreData {
  version: 1;
  invites: Record<string, InviteRecord>;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function emptyData(): StoreData {
  return { version: 1, invites: {} };
}

/** `kfp-7q2-xm4` の形。約45ビット。 */
export function generateInviteCode(): string {
  const blocks: string[] = [];
  for (let b = 0; b < BLOCK_COUNT; b += 1) {
    let block = '';
    for (let i = 0; i < BLOCK_LENGTH; i += 1) {
      block += ALPHABET[randomInt(ALPHABET.length)];
    }
    blocks.push(block);
  }
  return blocks.join('-');
}

/**
 * 入力された合言葉を照合できる形に正規化する。
 * 大文字で書かれても、ハイフンを抜かれても、空白が混ざっても通す——
 * 手で書き写す前提のものを、表記の揺れで弾かない。
 */
export function normalizeInviteCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}

export class InviteStore {
  private data: StoreData = emptyData();
  private readonly filePath: string | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<StoreData>;
      if (parsed.version !== 1) throw new Error(`unsupported version: ${String(parsed.version)}`);
      this.data = { version: 1, invites: parsed.invites ?? {} };
      this.prune();
    } catch (error) {
      // 招待が消えるだけなら再発行すれば済む。利用者と違い、ここは起動を止めない。
      console.error(`[invites] failed to read ${this.filePath}, starting empty:`, error);
      this.data = emptyData();
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** 期限切れで未使用のものを捨てる。使用済みは記録として残す。 */
  private prune(): void {
    const cutoff = nowSec();
    let changed = false;
    for (const [id, invite] of Object.entries(this.data.invites)) {
      if (invite.usedAt === undefined && invite.expiresAt <= cutoff) {
        delete this.data.invites[id];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * 招待を発行する。**合言葉の平文を返せるのはこの1回だけ。**
   * 保存するのはハッシュなので、後から思い出すことはできない（再発行するしかない）。
   */
  create(params: {
    userId: string;
    projects: string[];
    enableDelete: boolean;
    ttlSec?: number;
  }): { invite: InviteRecord; code: string } {
    const code = generateInviteCode();
    const created = nowSec();
    const invite: InviteRecord = {
      id: `inv_${createHash('sha256').update(`${code}${created}`).digest('hex').slice(0, 12)}`,
      codeHash: hashCode(code),
      userId: params.userId,
      projects: params.projects,
      enableDelete: params.enableDelete,
      createdAt: created,
      expiresAt: created + (params.ttlSec ?? DEFAULT_INVITE_TTL_SEC),
    };
    this.data.invites[invite.id] = invite;
    this.persist();
    return { invite, code };
  }

  /**
   * 合言葉から招待を引く。使用済み・期限切れは引けない。
   *
   * 消費はしない——登録が最後まで通ってから `consume` する。ここで消すと、
   * パスフレーズの入力ミス1回で招待が失われる。
   */
  find(code: string): InviteRecord | undefined {
    this.prune();
    const target = Buffer.from(hashCode(code), 'hex');
    for (const invite of Object.values(this.data.invites)) {
      if (invite.usedAt !== undefined) continue;
      const stored = Buffer.from(invite.codeHash, 'hex');
      if (stored.length === target.length && timingSafeEqual(stored, target)) {
        return invite.expiresAt > nowSec() ? invite : undefined;
      }
    }
    return undefined;
  }

  /** 登録が完了した招待を使用済みにする。 */
  consume(id: string): void {
    const invite = this.data.invites[id];
    if (!invite) throw new InviteError('Invite not found');
    if (invite.usedAt !== undefined) throw new InviteError('Invite has already been used');
    invite.usedAt = nowSec();
    this.persist();
  }

  /** 未使用の招待を取り消す。 */
  revoke(id: string): boolean {
    const invite = this.data.invites[id];
    if (!invite || invite.usedAt !== undefined) return false;
    delete this.data.invites[id];
    this.persist();
    return true;
  }

  list(): InviteRecord[] {
    this.prune();
    return Object.values(this.data.invites).sort((a, b) => b.createdAt - a.createdAt);
  }
}
