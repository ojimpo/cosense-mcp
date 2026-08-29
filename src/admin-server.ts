/**
 * 管理画面。招待の発行と、誰が登録して使っているかの一覧。
 *
 * **MCP とは別のポートで待ち受ける。** Cloudflare Tunnel が通しているのは MCP の
 * ポートだけなので、こちらはインターネットから到達できず、LAN と Tailscale からしか
 * 開けない。公開面を増やさずに、運用者はスマホからも触れる。
 *
 * ログイン画面を公開しないことが一番の防御になる——パスフレーズで守るのは当然として、
 * そもそも総当たりを始められる場所に置かない。
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { OAuthConfig } from './auth/config.js';
import type { OAuthStore } from './auth/store.js';
import { DEFAULT_INVITE_TTL_SEC } from './auth/invites.js';
import { renderAdminDashboard, renderAdminLogin, type AdminUserRow } from './auth/admin-pages.js';
import { FixedWindowRateLimiter } from './auth/rate-limit.js';

const SESSION_COOKIE = 'cosense_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  csrfToken: string;
  expiresAt: number;
}

export interface AdminServerOptions {
  config: OAuthConfig;
  store: OAuthStore;
  /** 直前に発行した合言葉を一度だけ見せるための受け渡し。 */
  trustProxy?: string | number | boolean | undefined;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function createAdminApp(options: AdminServerOptions): Express {
  const { config, store } = options;
  const app = express();
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);

  const sessions = new Map<string, Session>();
  const loginLimiter = new FixedWindowRateLimiter(10, 15 * 60 * 1000);
  // 発行直後の合言葉。保存はハッシュだけなので、画面に一度出したら終わり。
  let pendingCode: { code: string; userId: string } | undefined;

  const body = express.urlencoded({ extended: false });

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  };

  const currentSession = (req: Request): { id: string; session: Session } | undefined => {
    sweep();
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return undefined;
    const session = sessions.get(id);
    return session ? { id, session } : undefined;
  };

  const requireSession: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    if (!currentSession(req)) {
      res.status(401).type('html').send(renderAdminLogin());
      return;
    }
    next();
  };

  /** POST は必ず CSRF トークンを見る。ローカルのページでも、他サイトからは投げられる。 */
  const requireCsrf = (req: Request, res: Response): boolean => {
    const found = currentSession(req);
    const submitted = (req.body as { csrf?: unknown }).csrf;
    if (found && typeof submitted === 'string' && constantTimeEqual(found.session.csrfToken, submitted)) return true;
    res.status(403).type('html').send(renderAdminLogin('Session expired. Sign in again.'));
    return false;
  };

  const dashboard = (req: Request, res: Response, error?: string): void => {
    const found = currentSession(req)!;
    const summary = store.summarizeUsers();
    const clientName = (clientId: string): string => store.getClient(clientId)?.client_name ?? clientId;

    const users: AdminUserRow[] = config.users.describe().map((user) => {
      const grants = summary.get(user.id);
      return {
        ...user,
        grants: grants?.grants ?? 0,
        hasSid: grants?.hasSid ?? false,
        clients: (grants?.clientIds ?? []).map(clientName),
      };
    });

    const invites = (config.invites?.list() ?? []).map((invite) => ({
      id: invite.id,
      userId: invite.userId,
      projects: invite.projects,
      enableDelete: invite.enableDelete,
      expiresAt: invite.expiresAt,
      ...(invite.usedAt !== undefined ? { usedAt: invite.usedAt } : {}),
    }));

    const code = pendingCode;
    pendingCode = undefined; // 一度出したら消す。再読み込みで蒸し返さない
    res.type('html').send(
      renderAdminDashboard({
        csrfToken: found.session.csrfToken,
        users,
        invites,
        ...(code ? { newCode: code.code, newCodeFor: code.userId } : {}),
        ...(error !== undefined ? { error } : {}),
      })
    );
  };

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    if (!currentSession(req)) {
      res.type('html').send(renderAdminLogin());
      return;
    }
    dashboard(req, res);
  });

  app.post('/login', body, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const key = req.ip ?? 'unknown';
    if (!loginLimiter.tryConsume(key)) {
      res.status(429).type('html').send(renderAdminLogin('Too many attempts. Try again later.'));
      return;
    }
    const passphrase = typeof (req.body as { passphrase?: unknown }).passphrase === 'string'
      ? ((req.body as { passphrase: string }).passphrase)
      : '';

    // 運用者のパスフレーズだけを受け付ける。利用者のもので入れてしまうと、
    // 招待された人が招待する側に回れる。
    let isOperator = false;
    try {
      isOperator = config.users.authenticate(passphrase)?.id === 'default';
    } catch {
      isOperator = false;
    }
    if (!isOperator) {
      res.status(401).type('html').send(renderAdminLogin('Incorrect passphrase.'));
      return;
    }
    loginLimiter.reset(key);

    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { csrfToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + SESSION_TTL_MS });
    // `tailscale serve` 越しなら HTTPS なので Secure を付ける。IPで直に開いた場合は
    // 平文 HTTP になるため付けない——決め打ちで付けると cookie が保存されず、
    // ログインできているのに毎回ログイン画面に戻る、という分かりにくい壊れ方をする。
    // どちらの経路も WireGuard の内側なので、盗聴の面では差がない。
    const secure = req.secure ? ' Secure;' : '';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${id}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    res.redirect(302, '/');
  });

  app.post('/logout', body, requireSession, (req, res) => {
    const found = currentSession(req);
    if (found) sessions.delete(found.id);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.redirect(302, '/');
  });

  app.post('/invites', body, requireSession, (req, res) => {
    if (!requireCsrf(req, res)) return;
    const form = req.body as { user_id?: unknown; projects?: unknown; enable_delete?: unknown; ttl_hours?: unknown };
    const userId = typeof form.user_id === 'string' ? form.user_id.trim() : '';

    if (!/^[A-Za-z0-9_-]{1,40}$/.test(userId)) {
      dashboard(req, res, 'User id must be 1-40 characters of letters, digits, hyphen or underscore.');
      return;
    }
    if (config.users.get(userId)) {
      dashboard(req, res, `'${userId}' already exists. Pick a different name.`);
      return;
    }
    if (!config.invites) {
      dashboard(req, res, 'Invites are not enabled (MCP_USERS_STORE is unset).');
      return;
    }

    const projects = typeof form.projects === 'string'
      ? form.projects.split(',').map((name) => name.trim()).filter(Boolean)
      : [];
    const ttlHours = typeof form.ttl_hours === 'string' ? Number.parseInt(form.ttl_hours, 10) : NaN;
    const ttlSec = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 : DEFAULT_INVITE_TTL_SEC;

    const { code } = config.invites.create({
      userId,
      projects,
      enableDelete: form.enable_delete === '1',
      ttlSec,
    });
    console.error(`[invites] created for '${userId}' (projects: ${projects.join(', ') || 'server default'})`);
    pendingCode = { code, userId };
    res.redirect(302, '/');
  });

  app.post('/invites/revoke', body, requireSession, (req, res) => {
    if (!requireCsrf(req, res)) return;
    const inviteId = typeof (req.body as { invite_id?: unknown }).invite_id === 'string'
      ? ((req.body as { invite_id: string }).invite_id)
      : '';
    config.invites?.revoke(inviteId);
    res.redirect(302, '/');
  });

  app.post('/users/remove', body, requireSession, (req, res) => {
    if (!requireCsrf(req, res)) return;
    const userId = typeof (req.body as { user_id?: unknown }).user_id === 'string'
      ? ((req.body as { user_id: string }).user_id)
      : '';
    if (!config.users.removeUser(userId)) {
      dashboard(req, res, `Could not remove '${userId}'. Users from the config file cannot be removed here.`);
      return;
    }
    // 認可も落とす。残すと、消したはずの人がトークンの寿命の分だけ使い続けられる。
    const revoked = store.revokeUserTokens(userId);
    console.error(`[admin] removed user '${userId}' and revoked ${revoked} grants`);
    res.redirect(302, '/');
  });

  return app;
}

export function startAdminServer(port: number, options: AdminServerOptions) {
  const app = createAdminApp(options);
  return app.listen(port, '0.0.0.0', () => {
    console.error(`[admin] listening on http://0.0.0.0:${port} — do not route this port through a public tunnel`);
  });
}
