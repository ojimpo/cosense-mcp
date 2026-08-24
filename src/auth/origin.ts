/**
 * `Origin` ヘッダの検証。
 *
 * MCP の Streamable HTTP は「サーバーは全ての受信接続で Origin を検証しなければならない
 * (MUST)」としている（DNSリバインディング対策）。このサーバーはリモート公開かつ Bearer 必須で、
 * Cookie を使わないため実際の危険度は低いが、仕様は仕様なので実装する。
 *
 * ブラウザ以外のクライアント（Claude.ai / ChatGPT のサーバー間呼び出し）は Origin を送らない。
 * **Origin が付いているときだけ**判定し、無い場合は通す。
 */

/** ブラウザから叩いてくることが分かっているクライアントのオリジン。 */
const KNOWN_CLIENT_ORIGINS = ['https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com'];

export type OriginPolicy = 'enforce' | 'report';

export interface OriginCheck {
  allowed: boolean;
  /** report モードでは allowed=true のまま、記録すべき理由を返す。 */
  reason?: string;
}

function isLoopback(origin: URL): boolean {
  return origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]';
}

export class OriginValidator {
  private readonly allowed: Set<string>;

  constructor(
    /** 明示的な許可リスト。空なら既定リスト＋report モードになる。 */
    configuredOrigins: string[] | undefined,
    /** このサーバー自身の公開オリジン（同一オリジンのページからの呼び出しを許すため）。 */
    selfOrigin: string | undefined
  ) {
    const configured = configuredOrigins?.filter(Boolean) ?? [];
    this.policy = configured.length > 0 ? 'enforce' : 'report';
    const base = configured.length > 0 ? configured : KNOWN_CLIENT_ORIGINS;
    this.allowed = new Set(base);
    if (selfOrigin) this.allowed.add(selfOrigin);
  }

  /**
   * 明示設定があるときだけ拒否する。既定は report（ログに残すだけ）。
   *
   * 既定を enforce にすると、未知のクライアントが Origin を送ってきた瞬間に本番が壊れる。
   * 実トラフィックで何が来ているかを見てから締める、という順番にしている。
   */
  readonly policy: OriginPolicy;

  check(originHeader: string | undefined): OriginCheck {
    // ブラウザ以外は Origin を送らない。ここで弾くとサーバー間呼び出しが全滅する。
    if (!originHeader) return { allowed: true };

    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      return { allowed: this.policy === 'report', reason: `malformed Origin: ${originHeader}` };
    }

    // ローカルの MCP Inspector 等はポートが毎回変わるので、ホスト単位で許す。
    if (isLoopback(origin)) return { allowed: true };
    if (this.allowed.has(origin.origin)) return { allowed: true };

    return { allowed: this.policy === 'report', reason: `disallowed Origin: ${origin.origin}` };
  }
}
