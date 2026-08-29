/**
 * 1接続分の設定を決める。
 *
 * HTTP transport ではセッションごとに別の MCP サーバーを作るので、ここが
 * 「どの利用者が、どのプロジェクトに、どの SID で、どこまでの操作をできるか」を
 * 一箇所で決める場所になる。環境変数を各所で読みに行く形のままだと、
 * プロセスに設定が1つしか無い前提が残り、利用者を分けた瞬間に取り違える。
 */

import type { UserDirectory } from './auth/users.js';

export interface SessionConfig {
  projectName: string;
  cosenseSid: string | undefined;
  /** 触れるプロジェクト。undefined は無制限（従来どおり）。 */
  allowedProjects: string[] | undefined;
  enableDelete: boolean;
  /** サーバー既定の設定そのままか。起動時に取得済みの resources を出してよいかの判断に使う。 */
  isDefaultSession: boolean;
  /** ログ用。誰の接続かを追えるようにする。 */
  userId: string;
}

/** 環境変数だけから決まる既定値。 */
export interface SessionDefaults {
  projectName: string;
  cosenseSid: string | undefined;
  allowedProjects: string[] | undefined;
  enableDelete: boolean;
}

/** `AuthInfo` のうち、ここで必要な部分だけ。SDK の型に依存させない。 */
export interface AuthInfoLike {
  extra?: Record<string, unknown> | undefined;
}

function readString(extra: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = extra?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function defaultSession(defaults: SessionDefaults): SessionConfig {
  return {
    projectName: defaults.projectName,
    cosenseSid: defaults.cosenseSid,
    allowedProjects: defaults.allowedProjects,
    enableDelete: defaults.enableDelete,
    isDefaultSession: true,
    userId: 'default',
  };
}

/**
 * 認証結果から接続の設定を決める。
 *
 * 利用者を特定できなければ既定に落とす。これは stdio と、users.json を使っていない
 * 従来構成のための道で、そこでは「既定＝運用者本人」なので問題にならない。
 */
export function resolveSessionConfig(
  authInfo: AuthInfoLike | undefined,
  users: UserDirectory | undefined,
  defaults: SessionDefaults
): SessionConfig {
  const userId = readString(authInfo?.extra, 'userId');
  const profile = users && userId ? users.get(userId) : undefined;
  if (!profile) return defaultSession(defaults);

  // 本人入力の利用者には、本人が入れた SID しか渡さない。復号できなかったときに
  // サーバーの SID へ落とすと、その人が運用者の権限で書けてしまう——
  // 「SIDが無くて書けない」より「他人の権限で書けた」ほうが桁違いに悪い。
  const cosenseSid =
    profile.sidSource === 'consent' ? readString(authInfo?.extra, 'cosenseSid') : defaults.cosenseSid;

  const usesServerProjects = profile.projects.length === 0;
  return {
    projectName: profile.projects[0] ?? defaults.projectName,
    cosenseSid,
    allowedProjects: usesServerProjects ? defaults.allowedProjects : profile.projects,
    enableDelete: profile.enableDelete,
    isDefaultSession: profile.sidSource === 'env' && usesServerProjects,
    userId: profile.id,
  };
}

/**
 * ツールスキーマの `projectName` に添える説明文。
 *
 * 許可リストは柵であると同時に**メニュー**でもある。クライアントには既定プロジェクト
 * 以外の名前を知る手段が他に無く、ここに書かなければ、許可したプロジェクトは
 * 事実上呼ばれないままになる。接続ごとに許可範囲が違うので、プロセス起動時ではなく
 * 接続ごとに組み立てる——固定にすると、友人のクライアントに運用者のプロジェクト名が並ぶ。
 */
export function describeProjectName(session: SessionConfig): string {
  const base = `Target project name. If not specified, defaults to '${session.projectName}'.`;
  if (!session.allowedProjects || session.allowedProjects.length === 0) return base;
  // 既定プロジェクトは isProjectAllowed が暗黙に許可するので、列挙にも含める
  const allowed = [...new Set([session.projectName, ...session.allowedProjects].filter(Boolean))];
  return `${base} This connection may only touch these projects: ${allowed.join(', ')}.`;
}
