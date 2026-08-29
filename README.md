# cosense-mcp — Claude.aiからCosenseを読み書きするMCPサーバー

[worldnine/scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp) のフォークに、**Claude.ai Custom Connector対応（HTTP transport）** を追加したもの。

## このフォークの動機

Cosenseは自分の思考の外部記憶として使っているが、Claude.aiとの対話結果をCosenseに書き込む体験がずっと悪かった。

- コードブロックのエスケープがしばしば失敗する
- リンクを安定して付けてくれないので手動補完が必要
- 本文がチャット画面にダーッと流れて見にくい
- ちょっと追記するたびにまた本文が流れる

MCP化すればこれらが構造的に解決する。tool callの折りたたみと結果サマリだけが表示され、本文はチャットを汚さない。Todoistでタスクを追加した時と同じ体験になる。

## フォーク元との違い

[worldnine/scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp) は非常に完成度の高いMCPサーバーだが、**stdio transport**（Claude Desktop / Claude Code向け）のみ対応。Claude.aiのCustom Connectorは**HTTP transport（Streamable HTTP）** を要求するため、そのままでは使えない。

このフォークで追加したもの:

| 追加項目 | 内容 |
|----------|------|
| **HTTP transport** | Express + `StreamableHTTPServerTransport`。`TRANSPORT=http`で起動 |
| **セッション管理** | 不明セッションに404を返してクライアントの再接続を誘導 |
| **OAuth 2.1認証** | Claude.aiとChatGPTの両方が受け付ける唯一の方式。認可サーバーを同梱（DCR・PKCE S256・audience検証） |
| **Cosense記法デフォルト化** | `format`のデフォルトを`scrapbox`に変更。記法ガイドは`get_notation_guide`で提供 |
| **書き込み前の記法リント** | APIは通るが表示が壊れる記法を、書き込む前に検出して警告 |
| **`rename_page`** | タイトル行の書き換えによるリネーム |
| **Docker / CF Tunnel** | Dockerfile、docker-compose.yml、Cloudflare Tunnel経由での公開手順 |

フォーク元のstdio transportもそのまま残してあるので、Claude Desktop / Claude Codeからも引き続き使える。

## 構成

```
Claude.ai / ChatGPT → HTTPS → Cloudflare Tunnel → Docker Container
                                                    |
                                          OAuth 2.1（認可サーバー同居）
                                                    |
                                          Express + MCP (Streamable HTTP)
                                              |               |
                                         REST API        WebSocket
                                         (読み取り)       (書き込み)
                                              |               |
                                         Cosense API (scrapbox.io)
```

- Cosense REST APIは**読み取り専用**。書き込みはWebSocket（socket.io）経由で`@cosense/std`の`patch()`を使用
- Cosenseへの認証は`connect.sid` cookie（`COSENSE_SID`）
- MCPクライアントからの認証は**OAuth 2.1**。認可サーバーを同じプロセスに同居させている（[認証（OAuth 2.1）](#認証oauth-21)）

## ツール一覧

| Tool | 説明 | 認証 |
|------|------|:---:|
| `get_page` | ページ内容・メタデータ・リンク取得 | 非公開PJのみ |
| `list_pages` | ソート・ページネーション付き一覧（既定100件、最大1000件。既定ソートは`updated`） | 非公開PJのみ |
| `search_pages` | 全文検索（最大100件） | 非公開PJのみ |
| `create_page` | 新規ページ作成（WebSocket経由） | 必須 |
| `insert_lines` | 指定行（複数行ブロック可）の後にテキスト挿入 | 必須 |
| `replace_lines` | 指定行・連続ブロックを置換（完全一致。重複時は`occurrence`でN番目を指定） | 必須 |
| `delete_lines` | 指定行・連続ブロックを削除（完全一致。重複時は`occurrence`でN番目を指定。タイトル行は削除不可） | 必須 |
| `get_smart_context` | ページと関連ページ（1-2ホップ）をまとめて取得 | 必須 |
| `get_page_url` | ページURLの生成 | 不要 |
| `get_notation_guide` | Cosense記法ガイドの取得（書き込み前に呼ぶ） | 不要 |
| `rename_page` | ページのリネーム（タイトル行の書き換え。他ページからのリンクは自動更新されないため、更新候補をレスポンスで案内） | 必須 |
| `delete_page` | ページごと削除。`COSENSE_ENABLE_DELETE=true`のときだけ登録される。`dryRun`対応 | 必須＋ゲート |
| `rewrite_page` | ページ本文を全置換（タイトル行は保持）。`COSENSE_ENABLE_DELETE=true`のときだけ登録される。`dryRun`対応 | 必須＋ゲート |

`create_page`、`insert_lines`、`replace_lines`はデフォルトでCosense記法。記法ルール（リンク、見出し、インデント、KaTeX数式等）の本体は`get_notation_guide`ツールのレスポンスで返し、各tool descriptionには「書き込み前に`get_notation_guide`を呼ぶこと」という指示と最小限のコア記法だけを置いている。

この構成にしているのは、Claude.aiがtools/list（ツール名・description）をプラットフォーム側でキャッシュし、コネクタを削除→再追加しないと再取得されないため。ガイド本文をランタイムレスポンスに置くことで、記法ルールの改善がサーバー再起動だけで即反映される。

### CLI

全ツールはCLIサブコマンドとしても使える。

```bash
scrapbox-cosense-mcp get <title>
scrapbox-cosense-mcp search <query>
scrapbox-cosense-mcp create <title> --body=TEXT
scrapbox-cosense-mcp insert <title> --after=TEXT --text=TEXT
scrapbox-cosense-mcp replace <title> --target=TEXT --newtext=TEXT
scrapbox-cosense-mcp delete-lines <title> --target=TEXT
scrapbox-cosense-mcp delete-page <title> [--dry-run]
scrapbox-cosense-mcp rewrite <title> --body=TEXT [--dry-run]
```

`--compact`（トークン節約）、`--json`、`--project=NAME` が共通で使える。詳細は `<command> --help`。

`delete` という名前は**受け付けない**。フォーク元では`delete`＝ページ削除、このフォークでは`delete`＝行削除を指していた。`delete_page`を取り込んだ結果、同じ名前が両方に存在して意味が逆になるため、曖昧さを説明して終了するだけのコマンドにしてある。どちらの癖で打っても、黙って違うことが起きない。

### 記法カスタマイズ

`get_notation_guide`が返す記法ガイドは、JSONファイルでカスタマイズできる。

```json
{
  "maxHeadingLevel": 1,
  "mathEnabled": true,
  "aggressiveLinking": true,
  "blankLineBeforeHeading": false,
  "customRules": ["箇条書きで簡潔に書く"]
}
```

| 項目 | デフォルト | 説明 |
|------|-----------|------|
| `maxHeadingLevel` | `1` | 見出しの最大レベル。1 = `[* ]`のみ、2 = `[** ]`まで |
| `mathEnabled` | `true` | KaTeX数式記法（`[$ ]` / `[$$ ]`）のガイドを含める |
| `aggressiveLinking` | `true` | 名詞・概念を積極的にリンクする指示を含める |
| `blankLineBeforeHeading` | `false` | 各見出しの**直前**に空行を1行入れてセクションを区切る（見出しと直下の本文は密着のまま。先頭の見出しは除外） |
| `customRules` | — | 追加のルールを記法ガイドに付与 |

環境変数 `COSENSE_NOTATION_CONFIG` にJSONファイルのパスを指定する。未指定時はデフォルト値が使われる。

### カスタムルールをCosenseページで管理する

環境変数 `COSENSE_NOTATION_PAGE` にページタイトルを指定すると、`get_notation_guide` はそのページの本文を取得して、ガイド末尾に「PROJECT CUSTOM RULES」（最優先ルール）として追記する。

```bash
COSENSE_NOTATION_PAGE=cosense-mcp記法ルール
```

- ルールはコードや設定ファイルではなく**Cosenseページとして編集**できる。ブラウザで直接書いてもいいし、MCP自身の`insert_lines`等でClaudeに書き換えさせてもいい（「今後はこう書いて」と言うだけでMCPが自分のルールを更新できる）
- 変更は次の`get_notation_guide`呼び出しから即反映。サーバー再起動もコネクタ再登録も不要
- ページが存在しない場合はガイドに「ページが見つからない（create_pageで作成できる）」と案内が入り、ベースのガイドはそのまま機能する

## セットアップ

### Claude.ai（Custom Connector + Docker）

```bash
git clone https://github.com/ojimpo/cosense-mcp.git
cd cosense-mcp
cp .env.example .env
docker compose up -d
```

`.env` に最低限これだけ要る。

```bash
COSENSE_PROJECT_NAME=your-project
COSENSE_SID=s%3A...                          # 非公開PJと書き込みに必要
MCP_PUBLIC_URL=https://mcp.yourdomain.com    # 公開オリジン
MCP_OAUTH_PASSPHRASE=<12文字以上>             # 同意画面のパスフレーズ
```

`MCP_PUBLIC_URL` と `MCP_OAUTH_PASSPHRASE` が揃うとOAuthが有効になる。**認証が1つも設定されていないと起動を拒否する**（意図的に開けたい場合のみ `MCP_ALLOW_UNAUTHENTICATED=true`）。

サーバーは `http://0.0.0.0:3000/mcp` で待ち受ける（PORTは.envで変更可能）。

外部公開にはCloudflare Tunnelを使う:

```bash
cloudflared tunnel create cosense-mcp
cloudflared tunnel route dns cosense-mcp mcp.yourdomain.com
# cloudflared config.yml の ingress に追加:
#   - hostname: mcp.yourdomain.com
#     service: http://localhost:3000
```

Claude.aiでの接続:
1. Settings → Connectors → カスタムコネクタを追加
2. 名前: `Cosense`、URL: `https://mcp.yourdomain.com/mcp`
3. OAuth Client ID / シークレットは**空のまま**（動的クライアント登録に対応しているので、クライアントが自分で登録する）
4. 追加 → 接続 → ブラウザで同意画面が開くので `MCP_OAUTH_PASSPHRASE` を入力

URLは`/mcp`まで含めること。ここがリソース識別子と一致していないと再認可ループに入る。

ChatGPTからも同じURLで繋がる（Developer modeのカスタムコネクタ）。ChatGPTはOAuth 2.1しか受け付けないので、認証なしでは接続できない。

### 友人に使ってもらう（`MCP_USERS_FILE`）

単独利用のままだと、URLとパスフレーズを渡した相手は**自分と同じ権限**になる。同じSIDで書くので
Cosenseの履歴上は全部自分の編集になり、誰の操作か区別もつかない。

`MCP_USERS_FILE` に利用者を並べると、パスフレーズごとに「誰か」が決まり、SID・触れるプロジェクト・
破壊的ツールの可否が接続ごとに変わる。

```json
{
  "version": 1,
  "users": [
    {
      "id": "friend",
      "passphraseHash": "scrypt$...",
      "projects": ["shared"],
      "enableDelete": false
    }
  ]
}
```

| フィールド | 意味 |
|---|---|
| `id` | ログに出る識別子。ファイル内で一意 |
| `passphraseHash` | `scrypt$<salt>$<hash>`。`hashPassphrase()` で作る |
| `passphrase` | 平文でも書ける（起動時に警告）。ハッシュがあればそちらが優先 |
| `projects` | 触れるプロジェクト。先頭が既定。空ならサーバー既定に従う |
| `enableDelete` | `delete_page` / `rewrite_page` を見せるか。既定 `false` |
| `sidSource` | `consent`（既定・本人が同意画面で入力）か `env`（サーバーのSIDを使う） |

ハッシュはこう作る:

```bash
node -e "import('./build/auth/users.js').then(m => console.log(m.hashPassphrase('パスフレーズ')))"
```

**`.env` の `MCP_OAUTH_PASSPHRASE` は、このファイルがあっても運用者本人として残る。**
users.json を壊したときに自分まで締め出されると、直す手段ごと失うため。users.json 側で
`default` を名乗ればそちらが優先される。

#### 招待で登録してもらう

`users.json` を手で書くかわりに、**使い捨ての合言葉**を渡す方法もある。運用者はファイルを
触らず再起動もしない。

```bash
# .env
MCP_USERS_STORE=/data/users-store.json   # 登録された利用者の置き場（招待の有効化条件）
MCP_ADMIN_PORT=4101                       # 管理画面のポート
```

管理画面で「誰向けか」「触れるプロジェクト」「破壊的ツールの可否」「有効期間」を決めると、
`kfp-7q2-xm4` のような合言葉が出る。**表示されるのはその一度だけ**（保存しているのはハッシュ）。

渡された人は、コネクタを登録したときに出る同意画面で:

1. 合言葉を入力
2. これから使うパスフレーズを決める（12文字以上）
3. 自分の Cosense SID を貼る

この1回の送信で登録と認可が両方終わる。以後は自分で決めたパスフレーズで再認可できる。

管理画面には、誰が登録していつ使ったか・触れるプロジェクト・有効な認可の数・接続している
クライアントが出る。**SIDは「保存されている」までしか出ない**（後述のとおり、表示する手段が無い）。
利用者を消すと認可も落ち、保存されていたSIDは復号不能になる。

##### 管理画面を公開しないこと

管理画面は MCP とは別ポートで、compose の既定は `127.0.0.1:4101`。
**Cloudflare Tunnel の ingress に足さないこと。** ログイン画面をインターネットに置かないことが
一番の防御になる。

すでにリバースプロキシ（Nginx Proxy Manager 等）で内向きのサブドメインを配っているなら、
そこへ載せるのが一番楽:

```bash
# .env — リバースプロキシのコンテナから届く必要があるので、ループバックにはしない
MCP_ADMIN_BIND=172.17.0.1
```

プロキシ側で `mcp-admin.example.internal` → `http://172.17.0.1:4101` を足す。

`tailscale serve` でも公開できるが、**先に Funnel の状態を確認すること**:

```bash
tailscale serve status --json | jq .AllowFunnel
```

**`true` になっているポートに serve すると、そのままインターネットに公開される。**
`funnel` と打ち間違えなくても同じ結果になる。Funnel オフのポートを明示的に選ぶこと:

```bash
tailscale serve --bg --https=9443 4101   # → https://<マシン名>.<tailnet>.ts.net:9443/
```

#### 相手のSIDを預かることについて

友人の分まで書き込むには、その人のSIDがサーバーに要る。SIDはCosenseアカウントのセッション
そのものなので、扱いは重い。このサーバーは次のようにしている。

- **SIDは運用者が設定ファイルに書かない。本人が同意画面で入力する**（`sidSource: "consent"`）。
  運用者が一度でも平文を見ていたら、後から暗号化しても意味がない
- **保存はアクセストークンから導いた鍵での封筒暗号。** ストアはトークンをSHA-256ハッシュでしか
  持たないので、平文のトークンはクライアントにしか無い。ディスク上には復号できない暗号文だけが残る
- **これはE2E暗号ではない。** サーバーはCosense APIを叩く瞬間に平文を持つ。運用者がコードを
  書き換えればいくらでも読める。防げるのは「ストアやバックアップが漏れたとき」と
  「運用者がうっかり中身を見たとき」であって、**運用者を信頼しなくてよくなるわけではない**
- リフレッシュトークンが期限切れになると、そのSIDは二度と復号できない。再認可して入れ直しになる
  （復旧手段を用意する＝運用者が開ける鍵を持つ、なので両立しない）

### Claude Desktop / Claude Code（stdio）

フォーク元と同じ方法で使える。詳細は[worldnine/scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp)を参照。

```bash
claude mcp add cosense \
  -e COSENSE_PROJECT_NAME=your_project \
  -e COSENSE_SID=your_sid \
  -- npx -y scrapbox-cosense-mcp
```

## 環境変数

### 必須

| 変数 | 説明 |
|------|------|
| `COSENSE_PROJECT_NAME` | 対象プロジェクト名 |
| `COSENSE_SID` | `connect.sid` cookie値（[取得方法](./docs/authentication.md)） |

### HTTP transport

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TRANSPORT` | `stdio` | `stdio`（Claude Desktop）か `http`（Claude.ai） |
| `PORT` | `3000` | HTTPポート（`TRANSPORT=http`時のみ） |
| `MCP_PUBLIC_URL` | — | 公開オリジン。これと`MCP_OAUTH_PASSPHRASE`の両方でOAuthが有効になる |
| `MCP_OAUTH_PASSPHRASE` | — | 同意画面のパスフレーズ（12文字以上） |
| `MCP_OAUTH_STORE` | — | クライアント登録・トークンの永続化先。未指定だと再起動で再認可が必要 |
| `MCP_OAUTH_ACCESS_TTL` | `3600` | アクセストークンの有効期間（秒） |
| `MCP_OAUTH_REFRESH_TTL` | `2592000` | リフレッシュトークンの有効期間（秒） |
| `MCP_OAUTH_RESOURCE_NAME` | `Cosense MCP` | 同意画面とメタデータに出す名前 |
| `MCP_TRUST_PROXY` | — | リバースプロキシ配下で接続元IPを復元（Expressの`trust proxy`に渡す値） |
| `MCP_ALLOWED_ORIGINS` | — | `/mcp`のCORS許可オリジンと`Origin`ヘッダ検証の許可リスト（カンマ区切り）。**未指定だとreportモード**（ログに残すだけで拒否しない） |
| `MCP_AUTH_TOKEN` | — | 固定Bearerトークン。ローカル用のフォールバック |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | 認証なしでHTTPを開くことを明示的に許可する |
| `MCP_USERS_FILE` | — | 利用者ごとの設定（許可プロジェクト・破壊的ツールの可否・SIDの出どころ）を書いたJSON。未指定なら従来どおり単独利用 |

### その他

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `COSENSE_PAGE_LIMIT` | `100` | 初期ページ取得数（1–1000） |
| `COSENSE_SORT_METHOD` | `updated` | ソート方法 |
| `COSENSE_EXCLUDE_PINNED` | `false` | ピン留めページを除外 |
| `COSENSE_NOTATION_CONFIG` | — | 記法カスタマイズ用JSONファイルのパス |
| `COSENSE_REQUEST_TIMEOUT_MS` | `30000` | Cosense APIへのリクエストを打ち切るまでの時間（ミリ秒）。これが無いとAPI側が詰まったときtool callが返らず、クライアントからは「セッションがフリーズした」ようにしか見えない |
| `COSENSE_LINT` | `warn` | 書き込み前の記法リント。`warn`＝書き込んだうえで警告、`strict`＝書き込まずエラー、`off`＝無効 |
| `COSENSE_ENABLE_DELETE` | — | `true`で`delete_page` / `rewrite_page`を有効化。未設定なら`tools/list`にも出ない |
| `COSENSE_PROJECT_ALLOW_LIST` | — | 操作を許可するプロジェクト名（カンマ区切り）。未設定なら無制限。`COSENSE_PROJECT_NAME`は暗黙に含まれる。設定すると各ツールの`projectName`の説明に許可済みプロジェクトが列挙され、クライアントが既定以外を指定できるようになる |

## 認証（OAuth 2.1）

リモートに公開するなら**OAuth以外の選択肢が無い**。ChatGPTのMCPコネクタは
[OAuth 2.1しか受け付けず](https://developers.openai.com/apps-sdk/build/auth)、APIキーもカスタムヘッダもサポートしない。
Claude.ai側は固定ヘッダ（`static_headers`）がbetaで提供されているが、
[`oauth_dcr`と`oauth_cimd`は標準サポート](https://claude.com/docs/connectors/building/authentication)。
つまり**両方のクライアントから使いたいなら OAuth 一本**になる。

幸い両者の要求はほぼ一致しているので、1回実装すれば両方に刺さる。

| 要求 | 実装 |
|------|------|
| RFC 9728 Protected Resource Metadata | `/.well-known/oauth-protected-resource/mcp`（パス無しの別名も用意） |
| PKCE S256必須 | SDKの`tokenHandler`が検証。メタデータで`code_challenge_methods_supported`を広告 |
| Dynamic Client Registration (RFC 7591) | `/register`。リダイレクトURIはhttps（loopbackのみhttp可）に限定 |
| 401 + `WWW-Authenticate` | `resource_metadata`付きで返し、クライアントに再認可先を教える |
| audience検証 (RFC 8707) | 認可時・トークン交換時・トークン検証時の3箇所で`resource`を突き合わせる |
| `Origin`検証 | ブラウザ以外は`Origin`を送らないので、**付いているときだけ**判定する。既定はreportモード |
| `iss`パラメータ | 認可レスポンスに必ず付ける。ChatGPTはこれを見て固定のリダイレクトURIに切り替える |

### なぜ認可サーバーを自前で持つか

外部IdPに委譲する選択肢（SDKの`ProxyOAuthServerProvider`）もあるが、
**DCRを素で受け付ける外部IdPが少ない**。委譲するとIdP側の設定作業と依存が増えるだけで、
利用者が1人のこのサーバーでは見返りが無い。認可サーバーをMCPサーバーと同じプロセスに同居させ、
利用者の認証はパスフレーズ1つで済ませている。

```
MCP_PUBLIC_URL=https://cosense-mcp.example.com
MCP_OAUTH_PASSPHRASE=<12文字以上>
MCP_OAUTH_STORE=/data/oauth-store.json
```

`MCP_PUBLIC_URL`から導かれるリソース識別子は`<origin>/mcp`。
**クライアントに入力するURLと1文字でも違うと再認可ループに入る**ので、ここは正確に。

### 認証なしで起動しない

`TRANSPORT=http`で認証が1つも設定されていない場合、サーバーは起動を拒否する。
このリポジトリの本番デプロイは、`MCP_AUTH_TOKEN`が`.env`でコメントアウトされていたために
**認証ミドルウェアごとmountされず、URLを知っていれば誰でも非公開プロジェクトを読み書きできる状態**で
動いていた。設定が「書いてあるのに効いていない」形で失敗したので、同じ失敗が黙って通らないようにしてある。
意図的に開けたい場合だけ`MCP_ALLOW_UNAUTHENTICATED=true`を明示する。

## 書き込み前の記法リント

`create_page` / `insert_lines` / `replace_lines` は書き込む前に本文を検査し、**APIには通るが表示が壊れる記法**を検出してレスポンスに警告を載せる。

| ルール | 内容 |
|--------|------|
| `decoration-inline-code` | `[* ]`（`[/ ]`・`[- ]`も同様）の中にバッククォートのインラインコードがある。Cosenseはインラインコードを装飾より先にトークナイズするため装飾が成立せず、`[*`と`]`が生のまま読者に見える。ブラケットの中の`[リンク]`は問題ないので誤検出しない |
| `code-block-blank-line` | `code:`ブロックの本文に空行がある。空行はブロックを終端するので、以降の行が枠外のプレーンテキストに落ちる。ブロックの直後を締める空行（見出し前の区切り等）は警告しない |

デフォルトは`warn`（書き込みは通して警告を返す）。既存の挙動を壊さないことと、リントの誤検出で書き込み自体が不可能になる事態を避けることを優先している。壊れたまま保存されるのを許容できない場合は`COSENSE_LINT=strict`にすると、警告が出た時点で書き込まずエラーを返す。

検出ロジックはCosenseが実際に描画に使うパーサ（`@progfay/scrapbox-parser`）の挙動に合わせてある。

## ライセンス

MIT（フォーク元と同じ）

## クレジット

このフォークは [worldnine/scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp) をベースにしています。フォーク元の充実した実装（7ツール、WebSocket書き込み、142+テスト）がなければ、このプロジェクトは成り立ちませんでした。
