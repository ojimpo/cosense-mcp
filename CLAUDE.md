# CLAUDE.md

worldnine/scrapbox-cosense-mcp のフォーク。Claude.ai Custom Connector対応（HTTP transport）を追加。

## このフォークの追加分

- `src/http-server.ts` — Express + StreamableHTTPServerTransport（HTTP transportの本体）
- `src/auth/` — OAuth 2.1 認可サーバー兼リソースサーバー（Claude.ai / ChatGPT 両対応の唯一の認証手段）
- `src/index.ts` — `TRANSPORT=http` でHTTPモード、デフォルトはstdio（フォーク元互換）
- `Dockerfile` — node:22-slim マルチステージビルド
- `docker-compose.yml` — `.env`で環境変数管理、ポート4100で稼働中
- デフォルトformatを`scrapbox`に変更（`create-page.ts`、`insert-lines.ts`）
- Cosense記法ガイドは`get_notation_guide`ツールのレスポンスで提供（descriptionには最小限のコア記法＋「先にget_notation_guideを呼ぶ」指示のみ）
- 不明セッションに404を返してクライアントの再接続を誘導

## デプロイ状況

- Docker (port 4100) → Cloudflare Tunnel → `cosense-mcp.ojimpo.com`
- CF Tunnel設定: `/etc/cloudflared/config.yml`（sudo必要）
- **認証: OAuth 2.1（2026-08-24 デプロイ済み）。** 匿名の `/mcp` は 401。
  パスフレーズは `.env` の `MCP_OAUTH_PASSPHRASE`
- クライアント登録とトークンは named volume `oauth-data` の `/data/oauth-store.json`。
  **`docker compose down -v` を打つと全クライアントの再認可が必要になる**ので、`-v` は付けない
- ロールバック用: イメージ `cosense-mcp-cosense-mcp:rollback-20260824`、`.env.bak.20260824`
- **`COSENSE_ENABLE_DELETE=true`（2026-08-24 有効化）。** `delete_page` / `rewrite_page` が
  `tools/list` に出ている（13ツール）。Claude.ai 側は `Delete page` を「都度確認」に自動分類した。
  無効に戻すなら `.env` の行を消して再起動すればよい（コネクタの再追加は不要）

## 認証（OAuth 2.1）

**リモート公開でOAuth以外の選択肢は無い。** ChatGPTのMCPコネクタはOAuth 2.1しか受け付けず、
APIキーもカスタムヘッダもサポートしない（`https://developers.openai.com/apps-sdk/build/auth`）。
Claude.aiの`static_headers`はbeta。両方から使う前提なら OAuth 一本になる。

実装は`src/auth/`。SDK 1.29.0 の `mcpAuthRouter` に載せているが、**SDKだけでは足りない部分がある**:

- **audience（RFC 8707 `resource`）をSDKは一切検証しない。** `AuthInfo.resource` を設定しても
  `requireBearerAuth` は見ていない。他リソース向けに発行されたトークンの持ち込みを防ぐのは
  `CosenseOAuthProvider.verifyAccessToken` の責任。消すと仕様のMUST違反になる
- **`createOAuthMetadata` は `authorization_response_iss_parameter_supported` を出さない。**
  これが無いと ChatGPT はコールバックごとに異なるリダイレクトURIを使う。
  `src/auth/index.ts` で拡張済みメタデータを `mcpAuthRouter` より先にmountして上書きしている。
  順番を入れ替えるとSDK側の素のメタデータが勝つので注意
- **RFC 9728 のメタデータをSDKはパス付きURLにしか置かない。** パス無しを見に来るクライアントのため
  `/.well-known/oauth-protected-resource` にも同じ内容を置いている

### 同意画面で踏んだ罠（2026-08-24、本番で2回失敗した）

**どちらも curl では再現しない。** CSPもフォームの暗黙送信もブラウザ側の挙動なので、
curlプローブとJestの結合テストは壊れたフローを全部素通りした。同意画面を触ったら
**実ブラウザで1回通すまで直ったと思わないこと**。

- **CSPの`form-action`はリダイレクト先にも適用される。** `form-action 'self'` だけだと、
  承認後の `302 → https://claude.ai/api/mcp/auth_callback` をブラウザがブロックする。
  サーバーログには `consent approved` が出ているのに、利用者には「ボタンを押しても無反応」に見える。
  同意画面を出す時点の `redirect_uri` のオリジンを `form-action` に足すこと（クライアントごとに違う）
- **HTMLの暗黙送信はDOM順で最初のsubmitボタンを送る。** `Deny` を先に置くと、
  パスフレーズ欄でEnterを押した利用者が拒否を送る。`Approve` をDOM上で先に置き、
  見た目の並びはCSSの `order` で調整する。`Deny` には `formnovalidate` が要る
  （パスフレーズ欄が `required` なので、無いと拒否すらできない）
- **承認は冪等にしておく。** pendingを承認時に消すと、二重送信・戻るボタン・
  リダイレクトが見えなかった押し直しが全部「expired」の行き止まりになる。
  pendingはTTLまで残し、同じ認可コードを返す（コードの単発性はトークンEP側で担保される）

**ログのミドルウェアはOAuthルーターより先にmountする。** 後ろに置くと `/authorize`・`/token`・
`/oauth/consent` が一切ログに残らず、認可の失敗を追う手段が無くなる。上の2つはログを出して初めて
「1回目の承認は成功していた」と分かった。

`Claude.ai` は `initialize` の前に `server/discover`（公開仕様に無い独自メソッド）をセッション無しで
投げてくる。**400を返すのが仕様どおり**なので直す対象ではない
（MCP Streamable HTTP: "Servers that require a session ID SHOULD respond to requests without an
`Mcp-Session-Id` header (other than initialization) with HTTP 400 Bad Request"）。
クライアントは`initialize`にフォールバックする。ログの文言だけ、事故に見えないようにしてある。

**Claude.ai は `Origin` ヘッダを送らない**（2026-08-24 に本番ログで実測。実リクエストに
`[origin]` の行が1つも出ない）。ブラウザではなくサーバー間で呼んでいるため。

**`Origin` 検証は既定で report モード。** 仕様は検証をMUSTと書いているが、**既定を enforce にすると
未知のクライアントが `Origin` を送ってきた瞬間に本番が落ちる**。`MCP_ALLOWED_ORIGINS` を明示したときだけ
拒否に切り替わる。実トラフィックのログ（`[origin] would block ...`）を見てから締めること。
ブラウザ以外は `Origin` を送らないので、**ヘッダが無いリクエストは常に通す**（ここで弾くと
Claude.ai / ChatGPT のサーバー間呼び出しが全滅する）。

**トークンの失効は認可単位。** アクセスとリフレッシュは同じ `grantId` で束ねてあり、
どちらを取り消しても対で消える（RFC 7009 2.1）。リフレッシュのローテーション時も `grantId` を
引き継ぐ — ここで新しいIDを振ると、古い世代が取り残されて失効しない。

リソース識別子は `<MCP_PUBLIC_URL の origin>/mcp`。**利用者が入力するURLと完全一致していないと
再認可ループに入る**ので、`MCP_PUBLIC_URL` を変えるときはクライアント側の登録も揃えること。

`TRANSPORT=http` で認証が1つも設定されていないと**起動を拒否する**（`MCP_ALLOW_UNAUTHENTICATED=true`
で明示的にオプトアウト可）。旧実装は `if (authToken)` の内側で認証ミドルウェアをmountしていたため、
`.env` の `MCP_AUTH_TOKEN` がコメントアウトされているだけで**認証ごと消える**という失敗の仕方をした。
2026-08-24 時点の本番はその状態で、URLを知っていれば誰でも非公開プロジェクトを読み書きできた。

## 変更時の手順

```bash
npm run build
docker compose down && docker compose build && docker compose up -d
```

tool description（ツール名・スキーマ含む）を変更した場合、**Claude.ai は設定画面でコネクタを開いた時点で
`tools/list` を取り直す**。削除→再追加までは要らない（2026-08-24、`COSENSE_ENABLE_DELETE` で
ツールが11→13に増えたとき、再認可も再追加もせずに反映されたのを実測）。
反映されないときの最終手段として削除→再追加が使える。
ただしハンドラー側ロジック変更（formatデフォルト、`get_notation_guide`が返す記法ガイド本文等）はサーバー再起動のみで反映。
記法ガイドを育てる変更は`buildNotationGuide`（`src/utils/notation-config.ts`）側に入れること — descriptionを触ると再登録が必要になる。

## フォーク元の更新取り込み

```bash
git fetch upstream
git merge upstream/main
```

現在の取り込み済み地点: upstream v0.10.1。

### 意図的に取り込んでいない upstream のツール

マージで再登場するので、衝突したら毎回同じ判断をすること。

| upstream | 判断 | 理由 |
|---|---|---|
| `edit_lines` | 取り込まない | フォークの`replace_lines`が上位互換。`occurrence`指定＋曖昧時エラー（upstreamは黙って先頭1件、または`matchAll`で全件）、記法リント配線済み、formatデフォルトが`scrapbox` |

upstream由来で取り込んだもの:

- `delete_lines`のタイトル行削除ガード（フォークの実装に移植）
- `delete_page` / `rewrite_page`（2026-08-24 に取り込み。経緯は下記）

### `delete_page` / `rewrite_page` を取り込んだ経緯

**取り込まなかった理由は「破壊的だから」ではなく「無認証で公開していたから」だった。**
OAuthを入れて前提が消えたので取り込んだ。同じ問いが再燃したときのために、いまの判断軸を書いておく:

- `COSENSE_ENABLE_DELETE=true` のときだけ有効。**未設定なら`tools/list`にも出さない**
  （ツール登録側と実行時の両方でゲートしている）。呼べる形で置いておかないのが一番効く
- フォーク側の調整: `rewrite_page`の`format`デフォルトは`scrapbox`（upstreamは`markdown`。
  既定でMarkdown変換に落ちるとCosense記法で書いた本文が黙って壊れる）。記法リントも配線済み
- CLIサブコマンドは`delete-page` / `rewrite`（フォークの`delete`は`delete_lines`のため）
- **本番で有効にするならコネクタの再追加が必要**（`tools/list`が変わるため）

CLIサブコマンド名: フォークは`replace`（upstreamは`edit`）。行削除は**`delete-lines`でupstreamと揃えた**。

**`delete` は受け付けない。** upstreamでは`delete`=ページ削除、フォークでは`delete`=行削除だった。
`delete_page`を取り込んだ結果、同じ名前が両方に存在して意味が逆という状態になったので、
曖昧さを説明して`exit 2`するだけのコマンドにしてある。**どちらの癖で打っても、黙って違うことが起きない。**
名前を復活させるなら、必ずどちらか一方の意味に固定できる根拠を先に用意すること。

## Commands

```bash
npm run build        # TypeScript → JavaScript (uses tsconfig.build.json)
npm run watch        # Auto-rebuild during development
npm run test         # Run Jest tests
npm run lint         # ESLint (console.log triggers warning)
npm run inspector    # Debug with MCP Inspector
```

## Architecture

### Tools (13)

| Tool | Description | Auth |
|---|---|---|
| `get_page` | Retrieve page content, metadata, and links | - |
| `list_pages` | List pages with sorting and pagination (max 1000) | - |
| `search_pages` | Keyword search (API limit: 100 results) | - |
| `create_page` | Create new page. Rejects if page already exists | SID |
| `get_page_url` | Generate URL from page title | - |
| `insert_lines` | Insert text after a target line/block (exact match, `occurrence` for duplicates). Appends to end if not found | SID |
| `replace_lines` | Replace a line or consecutive block (exact match, `occurrence` for duplicates). Supports N→M line expansion | SID |
| `delete_lines` | Delete a line or consecutive block (exact match, `occurrence` for duplicates). Refuses to delete the title line | SID |
| `get_smart_context` | Get page + linked pages (1-hop/2-hop) in AI-optimized format | SID |
| `get_notation_guide` | Return the full Cosense notation guide (call before writing content) | - |
| `rename_page` | Rename a page by rewriting its title line. Backlinks are NOT auto-updated (response lists candidates) | SID |
| `delete_page` | Delete a whole page. Gated by `COSENSE_ENABLE_DELETE`; supports `dryRun` | SID + gate |
| `rewrite_page` | Replace a page's entire content (title preserved). Gated by `COSENSE_ENABLE_DELETE`; supports `dryRun` | SID + gate |

### CLI

All tools are also available as CLI subcommands (`get`, `list`, `search`, `create`, `url`, `insert`, `replace`, `delete-lines`, `context`, `guide`, `rename`, `delete-page`, `rewrite`). Bare `delete` is rejected on purpose — see the fork/upstream naming note above. Run `scrapbox-cosense-mcp <command> --help` for usage. Key flags:

- `--compact` — Token-efficient output (85% smaller for list)
- `--json` — JSON output
- `--project=NAME` — Override project name

### Skill (SKILL.md)

`skills/scrapbox/SKILL.md` defines a Claude Code skill that wraps the CLI. When users invoke `/cosense`, Claude Code reads SKILL.md and executes CLI commands via Bash. Keep SKILL.md concise — details should be discoverable via `--help`.

### Desktop Extensions (.mcpb)

`manifest.json` + `.mcpbignore` enable Claude Desktop Extensions packaging. The `.mcpb` file is auto-built and attached to GitHub Releases by `release-mcpb.yml`. To build locally: `npm install --omit=dev && npx @anthropic-ai/mcpb pack`.

### Directory Structure

- `src/cosense.ts` — Scrapbox REST API client
- `src/routes/handlers/` — One handler module per tool
- `src/utils/format.ts` — Response formatting, `stringifyError`, `formatError`
- `src/utils/sort.ts` — Sorting with pinned page filtering
- `src/utils/markdown-converter.ts` — Markdown → Scrapbox conversion (uses `md2sb`)
- `src/utils/notation-lint.ts` — Pre-write lint for notation that the API accepts but Cosense renders wrong
- `src/auth/` — OAuth 2.1 (`config.ts` env resolution, `store.ts` persistence, `provider.ts` flow, `index.ts` Express wiring)
- `src/types/` — API response and MCP request/response type definitions
- `src/cli.ts` — CLI entry point (args → CLI mode, no args → MCP server)
- `src/index.ts` — Server entry point

### Design Decisions

- **WebSocket API (`@cosense/std`)** is used for `create_page` / `insert_lines` because the REST API has no page creation/editing endpoints
- **`create_page` rejects existing pages** (`persistent === true`). Without this check, `patch()` silently replaces all content since it's a diff-update API
- **`insert_lines` uses exact match**. Partial match risks inserting at unintended lines
- **`patch()` returns `Result<string, PushError>`**, not throw. Must check `result.ok`
- **Default sort is `updated`**. Aligned across API, display, and user expectations
- **Notation lint warns by default, it does not block.** The Cosense API stores whatever bytes it is given — breakage happens at render time, so the only place to catch it is before the write. Rules live in `src/utils/notation-lint.ts` and are validated against `@progfay/scrapbox-parser`, the parser Cosense actually renders with. Blocking is opt-in (`COSENSE_LINT=strict`) so a lint false positive can never make content unwritable

### Environment Variables

See README.md. Key variables:

- `COSENSE_PROJECT_NAME` — Target project (required)
- `COSENSE_SID` — Session ID for private projects and write operations
- `COSENSE_TOOL_SUFFIX` — Tool name suffix for multiple server instances
- `COSENSE_CONVERT_NUMBERED_LISTS` — Convert numbered lists to bullet lists
- `COSENSE_NOTATION_CONFIG` — Path to notation config JSON (heading levels, math, linking, custom rules)
- `COSENSE_NOTATION_PAGE` — Cosense page title holding user-editable custom rules; appended to the `get_notation_guide` response as highest-priority rules (fetched per call, no restart needed)
- `COSENSE_LINT` — Pre-write notation lint: `warn` (default — writes, then warns), `strict` (rejects the write), `off`
- `COSENSE_ENABLE_DELETE` — Exposes `delete_page` / `rewrite_page`. Unset means they are not registered at all
- `MCP_PUBLIC_URL` + `MCP_OAUTH_PASSPHRASE` — Enable OAuth. Both required; setting only one throws
- `MCP_OAUTH_STORE` — Where clients/tokens persist. Unset means a restart forces re-authorization
- `MCP_ALLOW_UNAUTHENTICATED` — Explicitly allow starting the HTTP transport with no auth
- `MCP_ALLOWED_ORIGINS` — CORS allowlist and `Origin` validation list. Unset = report-only mode

## CI/CD & Release

### GitHub Actions

- **pr.yml** — Quality check on PRs (lint → test → build)
- **security-scan.yml** — Security scan
- **auto-release.yml** — `release/v*` PR merge → auto-create tag + GitHub Release
- **publish-npm.yml** — `v*` tag push → auto-publish to npm
- **release-mcpb.yml** — GitHub Release → auto-build and attach .mcpb

### Release Process

1. Create `release/vX.Y.Z` branch, bump version in `package.json` + `manifest.json` + `.claude-plugin/plugin.json`
   - Note: the MCP `serverInfo.version` is read from `package.json` at runtime, so no separate bump is needed for `src/index.ts`
2. Create PR → CI passes → merge
3. Everything after merge is automatic (tag → npm → GitHub Release → .mcpb)

## TypeScript

- **Strict mode**: includes `exactOptionalPropertyTypes: true`
- **Path aliases**: `@/` → `src/` (configured in both TypeScript and Jest; runtime uses relative paths)
- **ESM**: imports use `.js` extensions
- **Dual config**: `tsconfig.json` (dev) and `tsconfig.build.json` (prod, excludes tests)
