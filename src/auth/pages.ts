/**
 * 認可フローで利用者に見せる最小限のHTML。
 * 外部アセットを一切読まない自己完結のページにしてある（CSPを緩める理由を作らないため）。
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem 1rem;
         display: flex; justify-content: center; background: Canvas; color: CanvasText; }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  dl { margin: 0 0 1.5rem; padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
       border-radius: 8px; font-size: 0.9rem; }
  dt { font-weight: 600; opacity: 0.7; }
  dd { margin: 0 0 0.75rem; word-break: break-all; }
  dd:last-child { margin-bottom: 0; }
  label { display: block; font-size: 0.9rem; margin-bottom: 0.35rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem;
          border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 6px;
          background: Canvas; color: CanvasText; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
  button { flex: 1; padding: 0.65rem; font-size: 1rem; border-radius: 6px; cursor: pointer;
           border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  button[value="approve"] { background: #2563eb; color: #fff; border-color: #2563eb; }
  /* DOM順はApprove→Denyだが、表示は打ち消し操作を左に置く慣習に合わせる。
     DOM順を戻すと、パスフレーズ欄でEnterを押したときにDenyが送信される。 */
  button[value="deny"] { order: -1; }
  .hint { font-size: 0.8rem; opacity: 0.7; margin: 0.35rem 0 1rem; }
  .optional { font-weight: 400; opacity: 0.65; }
  .field { margin-bottom: 0.25rem; }
  .error { padding: 0.6rem 0.8rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem;
           background: color-mix(in srgb, #dc2626 15%, transparent); color: #dc2626; }
  footer { margin-top: 1.5rem; font-size: 0.8rem; opacity: 0.6; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export interface ConsentPageParams {
  pendingId: string;
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
export function renderConsentPage(params: ConsentPageParams): string {
  const errorBlock = params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : '';
  const scopes = params.scopes.length > 0 ? params.scopes.join(', ') : '(none)';

  // 招待の欄は、招待を受け付けるサーバーでだけ出す。使えない入力欄を並べると、
  // 「どちらを埋めればいいのか」を利用者に考えさせることになる。
  const inviteBlock = params.invitesEnabled
    ? `<label for="invite_code">Invite code <span class="optional">— only if you were given one</span></label>
  <input class="field" id="invite_code" name="invite_code" type="text" autocomplete="off"
         spellcheck="false" autocapitalize="none" placeholder="kfp-7q2-xm4">
  <p class="hint">Leave this empty if you already have an account here.</p>`
    : '';
  const passphraseHint = params.invitesEnabled
    ? 'With an invite code: choose a passphrase (12+ characters) — you will use it every time you reconnect. Otherwise: the one you already use.'
    : 'Given to you by whoever runs this server.';

  return layout(
    'Authorize access',
    `
<h1>Authorize access to Cosense</h1>
${errorBlock}
<dl>
  <dt>Application</dt><dd>${escapeHtml(params.clientName)}</dd>
  <dt>Redirect to</dt><dd>${escapeHtml(params.redirectUri)}</dd>
  <dt>Resource</dt><dd>${escapeHtml(params.resource)}</dd>
  <dt>Scopes</dt><dd>${escapeHtml(scopes)}</dd>
</dl>
<form method="post" action="${escapeHtml(params.actionPath)}" autocomplete="off">
  <input type="hidden" name="pending_id" value="${escapeHtml(params.pendingId)}">
  ${inviteBlock}
  <label for="passphrase">Passphrase</label>
  <input class="field" id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <p class="hint">${passphraseHint}</p>
  <label for="sid">Cosense SID</label>
  <input class="field" id="sid" name="sid" type="password" autocomplete="off" spellcheck="false">
  <p class="hint">The <code>connect.sid</code> cookie from scrapbox.io — this is what lets the server act as you.
  It is stored encrypted under your access token, so the server operator cannot read it back.
  Leave blank only if the server already holds a SID for your account.</p>
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

/** リダイレクト先が確定できない状況（期限切れ等）で見せる行き止まりのページ。 */
export function renderErrorPage(message: string): string {
  return layout(
    'Authorization failed',
    `<h1>Authorization failed</h1>
<p class="error">${escapeHtml(message)}</p>
<footer>Reopening this page will not help — the request is gone from the server.
Go back to the client (in Claude.ai: Settings → Connectors → Connect) and start the connection again.</footer>`
  );
}
