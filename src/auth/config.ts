/**
 * OAuth 2.1 (MCP authorization) の設定解決。
 *
 * ChatGPT / Claude.ai のどちらも API キーやカスタムヘッダを受け付けないため、
 * リモート公開時の認証手段は OAuth 2.1 のみ。両者の要求は
 * - RFC 9728 Protected Resource Metadata
 * - PKCE S256
 * - Dynamic Client Registration (RFC 7591)
 * - 401 + WWW-Authenticate による再認可
 * - audience (RFC 8707 `resource`) のサーバー側検証
 * で一致しているので、1つの実装で両対応できる。
 */

import { UserDirectory } from './users.js';
import { UserStore } from './user-store.js';
import { InviteStore } from './invites.js';

/** アクセストークンの有効期間（秒）。 */
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 60 * 60;
/** リフレッシュトークンの有効期間（秒）。 */
const DEFAULT_REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;
/** 認可コードの有効期間（秒）。RFC 6749 は「最大10分」を推奨。 */
export const AUTHORIZATION_CODE_TTL_SEC = 10 * 60;
/** ログイン画面（未承認の認可リクエスト）の有効期間（秒）。 */
export const PENDING_AUTHORIZATION_TTL_SEC = 10 * 60;

/** このサーバーが発行する唯一のスコープ。 */
export const DEFAULT_SCOPE = 'mcp';

export interface OAuthConfig {
  /** 認可サーバーの issuer。パス・クエリ・フラグメントを持たないこと。 */
  issuerUrl: URL;
  /**
   * 保護対象リソースの識別子。
   * クライアントに入力させる URL と完全一致していなければならない
   * （Claude.ai / ChatGPT はここが1文字でも違うと再認可ループに入る）。
   */
  resourceUrl: URL;
  /**
   * 利用者ディレクトリ。パスフレーズから「誰か」を引くのはここだけの責任。
   * `MCP_USERS_FILE` が無ければ、環境変数のパスフレーズを持つ利用者が1人だけ入っている。
   */
  users: UserDirectory;
  /**
   * 招待の保存先。書き込めるユーザーストア（`MCP_USERS_STORE`）があるときだけ有効。
   * 未設定なら招待は使えず、利用者は静的な設定でしか増やせない。
   */
  invites?: InviteStore;
  /** トークン・クライアント登録の永続化先。未指定ならメモリのみ。 */
  storePath?: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  resourceName: string;
  scopesSupported: string[];
}

export class OAuthConfigError extends Error {}

/** 同じディレクトリの別ファイル。招待の置き場をユーザーストアに合わせるため。 */
function siblingPath(filePath: string, name: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? name : `${filePath.slice(0, slash)}/${name}`;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new OAuthConfigError(`${label} must be a positive integer (got: ${value})`);
  }
  return parsed;
}

/**
 * 環境変数から OAuth 設定を組み立てる。
 *
 * `MCP_PUBLIC_URL` と `MCP_OAUTH_PASSPHRASE` の両方が揃ったときだけ有効。
 * 片方だけ設定されている状態は「認証したいのに効いていない」事故そのものなので、
 * 黙って無効化せず例外にする。
 */
export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const publicUrl = env.MCP_PUBLIC_URL?.trim();
  const passphrase = env.MCP_OAUTH_PASSPHRASE;

  if (!publicUrl && !passphrase) return undefined;
  if (!publicUrl) {
    throw new OAuthConfigError('MCP_OAUTH_PASSPHRASE is set but MCP_PUBLIC_URL is missing; OAuth cannot be enabled');
  }
  if (!passphrase) {
    throw new OAuthConfigError('MCP_PUBLIC_URL is set but MCP_OAUTH_PASSPHRASE is missing; OAuth cannot be enabled');
  }
  if (passphrase.length < 12) {
    throw new OAuthConfigError('MCP_OAUTH_PASSPHRASE must be at least 12 characters');
  }

  let base: URL;
  try {
    base = new URL(publicUrl);
  } catch {
    throw new OAuthConfigError(`MCP_PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }

  const isLoopback = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !isLoopback) {
    throw new OAuthConfigError(`MCP_PUBLIC_URL must use https (got: ${base.protocol}//)`);
  }
  if (base.search || base.hash) {
    throw new OAuthConfigError('MCP_PUBLIC_URL must not contain a query string or fragment');
  }

  // issuer は origin 固定。resource は MCP エンドポイントのパスまで含める。
  const issuerUrl = new URL(base.origin);
  const resourceUrl = new URL('/mcp', base.origin);

  const storePath = env.MCP_OAUTH_STORE?.trim();

  // 環境変数のパスフレーズは常に「運用者本人」として残す。users.json を足したときに
  // そちらが壊れていても自分だけは入れる状態にしておかないと、直す手段ごと失う。
  const owner = UserDirectory.single(passphrase, { enableDelete: env.COSENSE_ENABLE_DELETE === 'true' });
  const usersFile = env.MCP_USERS_FILE?.trim();
  const staticUsers = usersFile ? UserDirectory.fromFile(usersFile, owner) : owner;
  if (usersFile) {
    console.error(`[users] loaded ${staticUsers.size} users from ${usersFile}: ${staticUsers.ids.join(', ')}`);
  }

  // 招待から登録された利用者の置き場。未指定なら招待は使えない（従来どおり静的な設定のみ）。
  const usersStorePath = env.MCP_USERS_STORE?.trim();
  const users = usersStorePath ? staticUsers.withStore(new UserStore(usersStorePath)) : staticUsers;
  if (usersStorePath) {
    console.error(`[users] writable store at ${usersStorePath}: ${users.size - staticUsers.size} enrolled`);
  }

  // 招待は「登録できる場所」が無いと成立しないので、ユーザーストアとセットで有効になる。
  const invitePath = env.MCP_INVITE_STORE?.trim() || (usersStorePath ? siblingPath(usersStorePath, 'invites.json') : undefined);
  const invites = usersStorePath && invitePath ? new InviteStore(invitePath) : undefined;
  if (invites) console.error(`[invites] enabled, store at ${invitePath}`);

  return {
    issuerUrl,
    resourceUrl,
    users,
    ...(invites ? { invites } : {}),
    ...(storePath ? { storePath } : {}),
    accessTokenTtlSec: parsePositiveInt(env.MCP_OAUTH_ACCESS_TTL, DEFAULT_ACCESS_TOKEN_TTL_SEC, 'MCP_OAUTH_ACCESS_TTL'),
    refreshTokenTtlSec: parsePositiveInt(env.MCP_OAUTH_REFRESH_TTL, DEFAULT_REFRESH_TOKEN_TTL_SEC, 'MCP_OAUTH_REFRESH_TTL'),
    resourceName: env.MCP_OAUTH_RESOURCE_NAME?.trim() || 'Cosense MCP',
    scopesSupported: [DEFAULT_SCOPE],
  };
}
