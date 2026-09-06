/**
 * 操作対象プロジェクトの制限（`COSENSE_PROJECT_ALLOW_LIST`）。
 *
 * 全ツールはパラメータで `projectName` の上書きを受け付ける。これはマルチプロジェクトを
 * 扱うための意図的な仕様であって、塞ぐべき穴ではない。ただし SID が届く範囲は既定プロジェクト
 * より広いことが多く、LLM が誤って別プロジェクトを指したときの歯止めが無い。
 *
 * 未設定なら従来どおり無制限（後方互換）。絞りたい人だけ絞る、オプトインの安全策。
 * `COSENSE_ENABLE_DELETE` と同じく、環境変数は呼び出しごとに読む。
 */

/** 許可リストを環境変数から読む。未設定・空なら undefined（＝無制限）。 */
export function getProjectAllowList(): string[] | undefined {
  const raw = process.env.COSENSE_PROJECT_ALLOW_LIST?.trim();
  if (!raw) return undefined;
  // カンマ区切りの各要素は前後の空白をトリムし、空要素は無視する
  const list = raw.split(',').map(name => name.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * 指定されたプロジェクトが許可されているか判定する。
 * 既定プロジェクト（`COSENSE_PROJECT_NAME`）は暗黙にリストに含まれる扱い。
 *
 * 照合は大文字小文字を区別する。Scrapbox のページ解決は寛容だが、ここまで寛容にすると
 * 表記違いで許可外のプロジェクトが通ってしまうため。
 */
export function isProjectAllowed(
  projectName: string,
  defaultProjectName: string | undefined
): boolean {
  const allowList = getProjectAllowList();
  if (!allowList) return true;
  if (defaultProjectName && projectName === defaultProjectName) return true;
  return allowList.includes(projectName);
}

/**
 * 拒否時のメッセージ。許可済みの一覧をそのまま見せる — 隠しても攻撃者には効かず、
 * 設定ミスを直す人が困るだけなので。
 */
export function projectNotAllowedMessage(
  projectName: string,
  defaultProjectName: string | undefined
): string {
  // 既定プロジェクトは暗黙に許可されるので、案内にも含めないと嘘になる
  const permitted = [
    ...(defaultProjectName ? [defaultProjectName] : []),
    ...(getProjectAllowList() ?? []),
  ];
  const unique = permitted.filter((name, index) => permitted.indexOf(name) === index);
  return `Project '${projectName}' is not allowed by COSENSE_PROJECT_ALLOW_LIST. Permitted projects: ${unique.join(', ')}`;
}

/**
 * 許可されていなければエラーメッセージ、許可されていれば undefined を返す。
 *
 * 例外ではなく戻り値にしてあるのは、プロジェクト名を `try` の外で解決しているハンドラが
 * あるため。投げるとそこだけ catch されない。呼び出し側は受け取った文字列を
 * それぞれの `formatError` に載せる。
 */
export function checkProjectAllowed(
  projectName: string,
  defaultProjectName: string | undefined
): string | undefined {
  if (isProjectAllowed(projectName, defaultProjectName)) return undefined;
  return projectNotAllowedMessage(projectName, defaultProjectName);
}
