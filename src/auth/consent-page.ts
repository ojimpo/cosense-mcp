/**
 * このフォーク固有の同意画面。upstream の画面にパスフレーズだけを入れる代わりに、
 * 本人の Cosense SID と招待コードの欄を足している。`CosenseOAuthProvider` の
 * 描画関数として注入する（upstream の `pages.ts` は触らない）。
 */

import { escapeHtml, layout } from './pages.js';

interface ForkConsentPageParams {
  pendingId: string;
  /** どのサーバーの資格情報かを示す表示専用の値（パスワードマネージャ用）。 */
  resourceHost: string;
  /** 招待を受け付けるサーバーかどうか。受け付けないなら欄自体を出さない。 */
  invitesEnabled?: boolean;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  actionPath: string;
  error?: string;
}

/**
 * パスフレーズ入力と同意を1画面で兼ねる。
 *
 * SID 欄をここに置いているのが肝。運用者が利用者の SID を預かって設定ファイルに
 * 書いてしまうと、暗号化しても運用者は平文を見たあとなので意味が無くなる。
 * 本人がこの画面で入力し、サーバーはトークンでしか開けない形で保存する。
 */
export function renderConsentPage(params: ForkConsentPageParams): string {
  const errorBlock = params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : '';
  const scopes = params.scopes.length > 0 ? params.scopes.join(', ') : '(none)';

  // 招待の欄は、招待を受け付けるサーバーでだけ出す。使えない入力欄を並べると、
  // 「どちらを埋めればいいのか」を利用者に考えさせることになる。
  const inviteBlock = params.invitesEnabled
    ? `<label for="invite_code">Invite code <span class="optional">— only if you were given one</span></label>
  <input class="field" id="invite_code" name="invite_code" type="text" autocomplete="off"
         data-1p-ignore data-lpignore="true"
         spellcheck="false" autocapitalize="none" placeholder="kfp-7q2-xm4">
  <p class="hint">Leave this empty if you already have an account here.</p>`
    : '';
  const passphraseHint = params.invitesEnabled
    ? 'With an invite code: choose a passphrase (12+ characters) — you will use it every time you reconnect. Otherwise: the one you already use.'
    : 'Given to you by whoever runs this server.';

  return layout(
    'Authorize access',
    `
<style>
  .optional { font-weight: 400; opacity: 0.65; }
  input[readonly] { opacity: 0.7; cursor: default; }
  details { margin: 0.35rem 0 1rem; font-size: 0.8rem; }
  summary { cursor: pointer; opacity: 0.8; padding: 0.2rem 0; }
  details ol { margin: 0.6rem 0 0; padding-left: 1.2rem; line-height: 1.7; }
  details li { margin-bottom: 0.2rem; }
  details p { margin: 0.6rem 0 0; opacity: 0.8; }
  .warn { color: #b45309; }
</style>
<h1>Authorize access to Cosense</h1>
${errorBlock}
<dl>
  <dt>Application</dt><dd>${escapeHtml(params.clientName)}</dd>
  <dt>Redirect to</dt><dd>${escapeHtml(params.redirectUri)}</dd>
  <dt>Resource</dt><dd>${escapeHtml(params.resource)}</dd>
  <dt>Scopes</dt><dd>${escapeHtml(scopes)}</dd>
</dl>
<!-- フォームに autocomplete="off" は付けない。1Password は補完では無視するが、
     保存プロンプトの判定には効いてしまう。個別に抑えたい欄は data-1p-ignore で名指しする。 -->
<form method="post" action="${escapeHtml(params.actionPath)}">
  <input type="hidden" name="pending_id" value="${escapeHtml(params.pendingId)}">
  <!-- パスワードマネージャは「ユーザー名＋パスワード」の対で保存対象を判定する。
       このサーバーにユーザー名の概念は無いが、対が無いと保存を提案してこない。
       readonly や tabindex="-1" にすると「入力できない欄」としてユーザー名候補から
       外されるので、**普通の編集可能な入力欄**にしてある（2026-08-29、readonly版が
       1Passwordに拾われずに実測で失敗した）。サーバーは username を読まない。 -->
  <label for="username">Server</label>
  <input class="field" id="username" name="username" type="text" autocomplete="username"
         value="${escapeHtml(params.resourceHost)}" spellcheck="false">
  <p class="hint">Just a label for your password manager. Changing it does nothing.</p>
  ${inviteBlock}
  <label for="passphrase">Passphrase</label>
  <input class="field" id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <p class="hint">${passphraseHint}</p>
  <label for="sid">Cosense SID</label>
  <!-- 2つ目の type=password があると「パスワード変更フォーム」に見えて、どちらを保存すべきか
       判定できなくなる。SID は保存させたい値ではないので、名指しで無視させる。 -->
  <input class="field" id="sid" name="sid" type="password" autocomplete="off"
         data-1p-ignore data-lpignore="true" spellcheck="false">
  <p class="hint">The <code>connect.sid</code> cookie from scrapbox.io. Leave blank only if the server
  already holds a SID for your account.</p>
  <details>
    <summary>How do I find it?</summary>
    <ol>
      <li>Open <code>https://scrapbox.io</code> in a browser and make sure you are signed in.</li>
      <li>Open the developer tools (<code>F12</code>, or <code>⌥⌘I</code> on a Mac).
          In Safari you have to enable the Develop menu first.</li>
      <li>Go to <strong>Application</strong> (Chrome, Edge) or <strong>Storage</strong> (Firefox, Safari),
          then <strong>Cookies</strong> → <code>https://scrapbox.io</code>.</li>
      <li>Find the row named <code>connect.sid</code> and copy its <strong>Value</strong>.
          It starts with <code>s%3A</code>.</li>
    </ol>
    <p>Signing out of Scrapbox invalidates it, and you will need to paste a new one here.</p>
  </details>
  <details>
    <summary>What does the server do with it?</summary>
    <p>This cookie <strong>is</strong> your Scrapbox session — anything you can do, it can do. There is no
    narrower credential to give; Cosense has no API key or per-project token.</p>
    <p>It is stored encrypted under a key derived from your own access token, which this server keeps only
    as a hash. A leaked backup or database file therefore yields nothing. <span class="warn">This is not
    end-to-end encryption:</span> the server must hold the plaintext at the moment it calls Cosense on your
    behalf, so whoever runs it could read it by changing the code. Only give this to someone you trust
    with your account.</p>
    <p>Every page you create or edit is recorded in Cosense as <strong>you</strong>, not as the server owner.</p>
  </details>
  <div class="actions">
    <button type="submit" name="action" value="approve">Approve</button>
    <!-- 拒否にパスフレーズは要らないので required の検証を飛ばす -->
    <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
  </div>
</form>
<footer>This grant lets the application read and write pages in your Cosense project.</footer>
`
  );
}

