/**
 * 管理画面のHTML。
 *
 * ここに **SID は出せない**。復号鍵は利用者のアクセストークンからしか作れないので、
 * サーバーは「暗号文が有るか無いか」しか答えられない。それが設計であって、
 * 表示を我慢しているのではない——この画面に SID を出す方法は存在しない。
 */

import { escapeHtml } from './pages.js';

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1.5rem 1rem;
         background: Canvas; color: CanvasText; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 0.75rem; }
  .sub { opacity: 0.6; font-size: 0.85rem; margin: 0 0 1.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  th { font-weight: 600; opacity: 0.7; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td.wrap { word-break: break-all; }
  .tag { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 999px; font-size: 0.72rem;
         border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  .tag.on { background: color-mix(in srgb, #16a34a 18%, transparent); border-color: transparent; }
  .tag.off { opacity: 0.5; }
  .muted { opacity: 0.5; }
  form.inline { display: inline; }
  fieldset { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px;
             padding: 1rem; margin: 0 0 1rem; }
  legend { font-size: 0.8rem; opacity: 0.7; padding: 0 0.4rem; }
  label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
  label:first-of-type { margin-top: 0; }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 0.95rem;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 6px;
    background: Canvas; color: CanvasText; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .row > * { flex: 1 1 12rem; }
  button { padding: 0.5rem 0.9rem; font-size: 0.9rem; border-radius: 6px; cursor: pointer;
           border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: Canvas; color: CanvasText; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; margin-top: 1rem; }
  button.danger { border-color: color-mix(in srgb, #dc2626 50%, transparent); color: #dc2626; padding: 0.25rem 0.55rem; font-size: 0.8rem; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.5rem; letter-spacing: 0.06em;
          padding: 1rem; border-radius: 8px; background: color-mix(in srgb, #2563eb 12%, transparent);
          text-align: center; margin: 0 0 0.5rem; user-select: all; }
  .error { padding: 0.6rem 0.8rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem;
           background: color-mix(in srgb, #dc2626 15%, transparent); color: #dc2626; }
  .notice { padding: 0.8rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.85rem;
            background: color-mix(in srgb, #16a34a 12%, transparent); }
  footer { margin-top: 2.5rem; font-size: 0.78rem; opacity: 0.55; line-height: 1.6; }
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

export function renderAdminLogin(error?: string): string {
  return layout(
    'Cosense MCP admin',
    `<h1>Cosense MCP</h1>
<p class="sub">Invite people and see who is using this server.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login">
  <label for="passphrase">Operator passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <button class="primary" type="submit">Sign in</button>
</form>`
  );
}

export interface AdminUserRow {
  id: string;
  source: 'static' | 'enrolled';
  projects: string[];
  enableDelete: boolean;
  sidSource: 'consent' | 'env';
  createdAt?: number | undefined;
  lastSeenAt?: number | undefined;
  grants: number;
  hasSid: boolean;
  clients: string[];
}

export interface AdminInviteRow {
  id: string;
  userId: string;
  projects: string[];
  enableDelete: boolean;
  expiresAt: number;
  usedAt?: number | undefined;
}

export interface AdminPageParams {
  csrfToken: string;
  users: AdminUserRow[];
  invites: AdminInviteRow[];
  /** 発行直後に一度だけ見せる合言葉。保存していないので、閉じたら二度と出せない。 */
  newCode?: string | undefined;
  newCodeFor?: string | undefined;
  error?: string | undefined;
}

function when(seconds: number | undefined): string {
  if (seconds === undefined) return '<span class="muted">—</span>';
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function projectList(projects: string[]): string {
  return projects.length > 0 ? escapeHtml(projects.join(', ')) : '<span class="muted">server default</span>';
}

export function renderAdminDashboard(params: AdminPageParams): string {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(params.csrfToken)}">`;

  const newCodeBlock = params.newCode
    ? `<div class="notice">
  <p style="margin:0 0 0.75rem">Invite for <strong>${escapeHtml(params.newCodeFor ?? '')}</strong> — copy it now.
  Only the hash is stored, so this cannot be shown again.</p>
  <p class="code">${escapeHtml(params.newCode)}</p>
  <p style="margin:0" class="muted">Valid for 24 hours, single use.</p>
</div>`
    : '';

  const userRows = params.users
    .map(
      (user) => `<tr>
  <td><strong>${escapeHtml(user.id)}</strong><br><span class="muted">${user.source === 'static' ? 'from config' : 'invited'}</span></td>
  <td>${projectList(user.projects)}</td>
  <td>${user.enableDelete ? '<span class="tag on">delete</span>' : '<span class="tag off">read/write</span>'}</td>
  <td>${user.hasSid ? '<span class="tag on">stored</span>' : `<span class="tag off">${user.sidSource === 'env' ? "server's" : 'none'}</span>`}</td>
  <td>${user.grants > 0 ? `${user.grants}<br><span class="muted">${escapeHtml(user.clients.join(', '))}</span>` : '<span class="muted">—</span>'}</td>
  <td>${when(user.lastSeenAt)}</td>
  <td>${
    user.source === 'enrolled'
      ? `<form class="inline" method="post" action="/users/remove">${csrf}
      <input type="hidden" name="user_id" value="${escapeHtml(user.id)}">
      <button class="danger" type="submit">Remove</button></form>`
      : '<span class="muted">—</span>'
  }</td>
</tr>`
    )
    .join('\n');

  const inviteRows = params.invites
    .map(
      (invite) => `<tr>
  <td><strong>${escapeHtml(invite.userId)}</strong></td>
  <td>${projectList(invite.projects)}</td>
  <td>${invite.enableDelete ? '<span class="tag on">delete</span>' : '<span class="tag off">read/write</span>'}</td>
  <td>${invite.usedAt !== undefined ? `<span class="muted">used ${when(invite.usedAt)}</span>` : `expires ${when(invite.expiresAt)}`}</td>
  <td>${
    invite.usedAt === undefined
      ? `<form class="inline" method="post" action="/invites/revoke">${csrf}
      <input type="hidden" name="invite_id" value="${escapeHtml(invite.id)}">
      <button class="danger" type="submit">Revoke</button></form>`
      : '<span class="muted">—</span>'
  }</td>
</tr>`
    )
    .join('\n');

  return layout(
    'Cosense MCP admin',
    `<h1>Cosense MCP</h1>
<p class="sub">Invite people and see who is using this server.</p>
${params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : ''}
${newCodeBlock}

<h2>Create an invite</h2>
<form method="post" action="/invites">
  ${csrf}
  <fieldset>
    <legend>The code carries these permissions — they cannot be widened later</legend>
    <div class="row">
      <div>
        <label for="user_id">Who is it for</label>
        <input id="user_id" name="user_id" type="text" required placeholder="taro"
               pattern="[A-Za-z0-9_-]{1,40}" autocapitalize="none" spellcheck="false">
      </div>
      <div>
        <label for="projects">Projects (comma separated)</label>
        <input id="projects" name="projects" type="text" placeholder="shared" autocapitalize="none" spellcheck="false">
      </div>
      <div>
        <label for="ttl_hours">Valid for (hours)</label>
        <input id="ttl_hours" name="ttl_hours" type="number" min="1" max="168" value="24">
      </div>
    </div>
    <label><input type="checkbox" name="enable_delete" value="1" style="width:auto"> Allow delete_page / rewrite_page</label>
  </fieldset>
  <button class="primary" type="submit">Create invite</button>
</form>

<h2>People (${params.users.length})</h2>
<table>
  <thead><tr><th>User</th><th>Projects</th><th>Tools</th><th>SID</th><th>Grants</th><th>Last used</th><th></th></tr></thead>
  <tbody>${userRows}</tbody>
</table>

<h2>Invites (${params.invites.length})</h2>
${
  params.invites.length > 0
    ? `<table>
  <thead><tr><th>For</th><th>Projects</th><th>Tools</th><th>Status</th><th></th></tr></thead>
  <tbody>${inviteRows}</tbody>
</table>`
    : '<p class="muted">None yet.</p>'
}

<footer>
<strong>SID column shows only whether one is stored.</strong> Each SID is sealed with a key derived from
that person's own access token, which this server never holds in the clear — so there is no code path,
here or anywhere else, that can display one. Removing a person destroys their grants and with them the
key material, making their stored SID permanently unreadable.
</footer>`
  );
}
