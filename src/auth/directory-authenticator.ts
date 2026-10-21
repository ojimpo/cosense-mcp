import { AmbiguousPassphraseError, hashPassphrase, type UserDirectory } from './users.js';
import type { InviteStore } from './invites.js';
import { ConsentError, type AuthenticatedUser, type ConsentAuthenticator, type ConsentSubmission } from './authenticator.js';

/** 招待から登録するとき、パスフレーズに求める最短の長さ。 */
const MIN_ENROLLED_PASSPHRASE_LENGTH = 12;

/**
 * 利用者ディレクトリ（`users.json` と招待で増える保存先）で人を通す `ConsentAuthenticator`。
 * upstream の既定実装は「環境変数のパスフレーズ 1 つ」。フォークはこれに差し替えて、
 * パスフレーズごとに別の人として扱い、招待からの登録も受け付ける。
 *
 * 同意画面に足した欄は、欄名のまま `submission` に入ってくる:
 * - `sid`: 本人が入力した Cosense SID
 * - `invite_code`: 招待の合言葉。あればこの認可で利用者を新しく作る
 */
export class UserDirectoryAuthenticator implements ConsentAuthenticator {
  constructor(
    private readonly users: UserDirectory,
    private readonly invites: InviteStore | undefined
  ) {}

  authenticate(submission: ConsentSubmission): AuthenticatedUser {
    const sid = submission.sid?.trim() ?? '';
    const inviteCode = submission.invite_code?.trim() ?? '';
    // 招待からの登録も、既存利用者の認証も、同じレート制限の内側に置かれる（呼び出し側）。
    const user = inviteCode
      ? this.enroll(inviteCode, submission.passphrase, sid)
      : this.authenticateExisting(submission.passphrase);
    if (user.sidSource === 'consent' && sid === '') {
      // ここを素通りさせると、認可は通るのに書き込みが全部認証エラーになる利用者ができる。
      throw new ConsentError('This account needs your own Cosense SID. Paste the connect.sid cookie value.');
    }
    return { id: user.id };
  }

  /** 既存の利用者としての認証。 */
  private authenticateExisting(passphrase: string) {
    // 同じパスフレーズが複数の利用者に当たる状態は設定ミス。ここで通すと、
    // 入力した本人も運用者も気づかないまま別人として振る舞うことになる。
    let user;
    try {
      user = this.users.authenticate(passphrase);
    } catch (error) {
      if (!(error instanceof AmbiguousPassphraseError)) throw error;
      console.error(`[users] ${error.message}; refusing to authenticate`);
      throw new ConsentError('This passphrase matches more than one account. Contact whoever runs this server.');
    }
    if (!user) {
      throw new ConsentError('Incorrect passphrase.');
    }
    return user;
  }

  /**
   * 招待からの登録。合言葉・これから使うパスフレーズ・SID が揃って初めて成立する。
   *
   * **招待を消費するのは全部通ってから。** 途中で断ったところで消費すると、
   * 入力ミス1回で招待が失われ、運用者が発行し直す羽目になる。
   */
  private enroll(inviteCode: string, passphrase: string, sid: string) {
    const invites = this.invites;
    if (!invites) {
      throw new ConsentError('This server does not accept invite codes.');
    }
    const invite = invites.find(inviteCode);
    if (!invite) {
      throw new ConsentError('That invite code is not valid, has expired, or has already been used.');
    }
    if (passphrase.length < MIN_ENROLLED_PASSPHRASE_LENGTH) {
      throw new ConsentError(`Choose a passphrase of at least ${MIN_ENROLLED_PASSPHRASE_LENGTH} characters.`);
    }
    if (this.users.isPassphraseTaken(passphrase)) {
      // 通すと、以後この2人はどちらも認証できなくなる（複数一致で撥ねられる）。
      throw new ConsentError('That passphrase is already in use here. Choose a different one.');
    }
    if (sid === '') {
      throw new ConsentError('Paste your own Cosense SID to finish signing up.');
    }

    this.users.addUser({
      id: invite.userId,
      passphraseHash: hashPassphrase(passphrase),
      projects: invite.projects,
      enableDelete: invite.enableDelete,
      sidSource: 'consent',
      createdAt: Math.floor(Date.now() / 1000),
      inviteId: invite.id,
    });
    invites.consume(invite.id);
    console.error(`[invites] ${invite.id} redeemed; enrolled user '${invite.userId}'`);

    const profile = this.users.get(invite.userId);
    if (!profile) throw new ConsentError('Sign-up failed. Contact whoever runs this server.');
    return profile;
  }
}
