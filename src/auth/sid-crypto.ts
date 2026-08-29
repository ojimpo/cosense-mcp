/**
 * Cosense SID の封筒暗号。
 *
 * 目的は「サーバー運用者が保存済みの SID を読めないようにする」こと。E2E ではない
 * ——サーバーは Cosense API を叩く瞬間に平文を持つので、原理的にそこは避けられない。
 * ここで防げるのは、ストアファイル・バックアップ・ボリュームが漏れたときと、
 * 運用者が何気なく中身を覗いたときの露出。
 *
 * 鍵をどこから作るかが設計の中心:
 *
 * - 環境変数のマスターキー → 運用者が読めるので、ディスク漏洩にしか効かない
 * - パスフレーズ由来 → 平文鍵をメモリにしか置けず、再起動のたびに全員再入力になる
 * - **トークン由来（これ）** → ストア側はトークンを SHA-256 ハッシュでしか持たない。
 *   平文のトークンはクライアントだけが持っていて、リクエストのたびに Authorization
 *   ヘッダで届く。つまりディスク上には復号不能な暗号文しか残らず、再起動もまたげる
 *
 * SID 本体はグラント単位の DEK で1回だけ暗号化し、その DEK をトークンごとに包む。
 * こうするとリフレッシュでトークンがローテートしても、包み直すのは32バイトの DEK だけで済む。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** HKDF のドメイン分離。用途ごとに info を変え、同じトークンから別々の鍵を作る。 */
const HKDF_SALT = 'cosense-mcp/sid/v1';
const INFO_DEK_WRAP = 'dek-wrap';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** AES-256-GCM の暗号文。JSON に落とせるよう base64 で持つ。 */
export interface SealedBox {
  iv: string;
  ct: string;
  tag: string;
}

export class SidDecryptError extends Error {}

/** 高エントロピーな秘密（トークン・認可コード）から鍵を導出する。 */
function deriveKey(secret: string, info: string): Buffer {
  // トークンは 32 バイトの乱数なので、パスワードのようなストレッチは要らない。
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT), Buffer.from(info), KEY_BYTES));
}

function seal(key: Buffer, plaintext: Buffer): SealedBox {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function open(key: Buffer, box: SealedBox): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
  } catch {
    // 認証タグの不一致は「鍵が違う」か「改竄された」かのどちらか。区別して伝える価値がない。
    throw new SidDecryptError('Stored SID could not be decrypted with this token');
  }
}

/** グラント1つに1本の DEK。SID の暗号文は再認可まで作り直さない。 */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** DEK を秘密（認可コード or トークン）で包む。 */
export function wrapDek(secret: string, dek: Buffer): SealedBox {
  return seal(deriveKey(secret, INFO_DEK_WRAP), dek);
}

/** 包まれた DEK を取り出す。秘密が違えば SidDecryptError。 */
export function unwrapDek(secret: string, box: SealedBox): Buffer {
  const dek = open(deriveKey(secret, INFO_DEK_WRAP), box);
  if (dek.length !== KEY_BYTES) throw new SidDecryptError('Unwrapped key has an unexpected length');
  return dek;
}

export function sealSid(dek: Buffer, sid: string): SealedBox {
  return seal(dek, Buffer.from(sid, 'utf8'));
}

export function openSid(dek: Buffer, box: SealedBox): string {
  return open(dek, box).toString('utf8');
}

/** 保存された箱が同じ内容かの比較（テスト用途。平文を晒さずに済ませる）。 */
export function sameBox(a: SealedBox, b: SealedBox): boolean {
  const left = Buffer.from(`${a.iv}|${a.ct}|${a.tag}`);
  const right = Buffer.from(`${b.iv}|${b.ct}|${b.tag}`);
  return left.length === right.length && timingSafeEqual(left, right);
}
