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
  clientName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  actionPath: string;
  error?: string;
}

/** パスフレーズ入力と同意を1画面で兼ねる（利用者が1人なので分ける意味がない）。 */
export function renderConsentPage(params: ConsentPageParams): string {
  const errorBlock = params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : '';
  const scopes = params.scopes.length > 0 ? params.scopes.join(', ') : '(none)';

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
  <label for="passphrase">Passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <div class="actions">
    <button type="submit" name="action" value="deny">Deny</button>
    <button type="submit" name="action" value="approve">Approve</button>
  </div>
</form>
<footer>This grant lets the application read and write pages in your Cosense project.</footer>
`
  );
}

/** リダイレクト先が確定できない状況（期限切れ等）で見せる行き止まりのページ。 */
export function renderErrorPage(message: string): string {
  return layout('Authorization failed', `<h1>Authorization failed</h1><p class="error">${escapeHtml(message)}</p>`);
}
