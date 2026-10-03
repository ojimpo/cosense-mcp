/**
 * 操作対象プロジェクトの制限（`COSENSE_PROJECT_ALLOW_LIST`）。
 *
 * 全ツールはパラメータで `projectName` の上書きを受け付ける。これはマルチプロジェクトを
 * 扱うための意図的な仕様であって、塞ぐべき穴ではない。ただし SID が届く範囲は既定プロジェクト
 * より広いことが多く、LLM が誤って別プロジェクトを指したときの歯止めが無い。
 *
 * 未設定なら従来どおり無制限（後方互換）。絞りたい人だけ絞る、オプトインの安全策。
 *
 * 判定関数は環境変数ではなく「許可リストそのもの」を受け取る。利用者ごとに許可範囲が
 * 違う以上、プロセス全体で1つの env を読みに行く形では表現できないため。
 * 環境変数から読むのは `getProjectAllowList` の役目に閉じてある。
 */

/**
 * 許可リストを環境変数から読む。**未設定のときだけ** undefined（＝無制限）。
 *
 * 設定されていれば、トリム後に名前が1つも残らなくても（`""` や `",,,"`）空配列を返して
 * 制限モードに入る。変数を書いた人は制限したい意図なので、「設定したつもりで無制限」より
 * 「既定プロジェクトだけ許可」に倒すほうが安全なため（upstream の要望で入った挙動）。
 */
export function getProjectAllowList(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.COSENSE_PROJECT_ALLOW_LIST;
  if (raw === undefined) return undefined;
  return raw.split(',').map(name => name.trim()).filter(Boolean);
}

/**
 * 指定されたプロジェクトが許可されているか判定する。
 * 既定プロジェクト（`COSENSE_PROJECT_NAME`）は暗黙にリストに含まれる扱い。
 */
export function isProjectAllowed(
  projectName: string,
  defaultProjectName: string | undefined,
  allowList: string[] | undefined
): boolean {
  if (!allowList) return true;
  if (defaultProjectName && projectName === defaultProjectName) return true;
  return allowList.includes(projectName);
}

/**
 * 拒否時のメッセージ。許可リストそのものを見せる — 隠しても攻撃者には効かず、
 * 設定ミスを直す人が困るだけなので。
 */
export function projectNotAllowedMessage(
  projectName: string,
  allowList: string[] | undefined,
  defaultProjectName?: string | undefined
): string {
  // 既定プロジェクトは暗黙に許可されるので、案内にも含めないと嘘になる。
  const permitted = [...(defaultProjectName ? [defaultProjectName] : []), ...(allowList ?? [])];
  const unique = permitted.filter((name, index) => permitted.indexOf(name) === index);
  // 実質空の許可リストで既定プロジェクトも無いと、許可されるものが1つも無い
  const listed = unique.length > 0 ? unique.join(', ') : '(none)';
  return `Project '${projectName}' is not allowed by COSENSE_PROJECT_ALLOW_LIST. Permitted projects: ${listed}`;
}

/**
 * 許可されていなければエラーメッセージ、許可されていれば undefined を返す。
 * 呼び出し側がそれぞれのエラー形式に載せられるよう、文字列だけを返す。
 */
export function checkProjectAllowed(
  projectName: string | undefined,
  defaultProjectName: string | undefined,
  allowList: string[] | undefined
): string | undefined {
  if (!projectName) return undefined;
  if (isProjectAllowed(projectName, defaultProjectName, allowList)) return undefined;
  return projectNotAllowedMessage(projectName, allowList, defaultProjectName);
}
