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
| **Bearer token認証** | `MCP_AUTH_TOKEN`でオプショナルな認証 |
| **Cosense記法デフォルト化** | `format`のデフォルトを`scrapbox`に変更。tool descriptionにCosense記法ガイドを埋め込み |
| **Docker / CF Tunnel** | Dockerfile、docker-compose.yml、Cloudflare Tunnel経由での公開手順 |

フォーク元のstdio transportもそのまま残してあるので、Claude Desktop / Claude Codeからも引き続き使える。

## 構成

```
Claude.ai → HTTPS → Cloudflare Tunnel → Docker Container (Express + MCP)
                                              |               |
                                         REST API        WebSocket
                                         (読み取り)       (書き込み)
                                              |               |
                                         Cosense API (scrapbox.io)
```

- Cosense REST APIは**読み取り専用**。書き込みはWebSocket（socket.io）経由で`@cosense/std`の`patch()`を使用
- `connect.sid` cookie（`COSENSE_SID`）で認証

## ツール一覧

| Tool | 説明 | 認証 |
|------|------|:---:|
| `get_page` | ページ内容・メタデータ・リンク取得 | 非公開PJのみ |
| `list_pages` | ソート・ページネーション付き一覧（最大1000件） | 非公開PJのみ |
| `search_pages` | 全文検索（最大100件） | 非公開PJのみ |
| `create_page` | 新規ページ作成（WebSocket経由） | 必須 |
| `insert_lines` | 指定行の後にテキスト挿入 | 必須 |
| `get_smart_context` | ページと関連ページ（1-2ホップ）をまとめて取得 | 必須 |
| `get_page_url` | ページURLの生成 | 不要 |

`create_page`と`insert_lines`はデフォルトでCosense記法。tool descriptionにCosense記法のルール（リンク、見出し、インデント等）を埋め込んであるので、Claude.aiは指示なしでも`[リンク]`を積極的に使い、適切な見出しサイズで書く。

## セットアップ

### Claude.ai（Custom Connector + Docker）

```bash
git clone https://github.com/ojimpo/scrapbox-cosense-mcp.git
cd scrapbox-cosense-mcp
cp .env.example .env
# .env を編集: COSENSE_PROJECT_NAME, COSENSE_SID を設定
docker compose up -d
```

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
1. Settings → Connectors → +
2. 名前: `Cosense`、URL: `https://mcp.yourdomain.com/mcp`
3. 追加

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
| `MCP_AUTH_TOKEN` | — | Bearer token認証（任意） |

### その他

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `COSENSE_PAGE_LIMIT` | `100` | 初期ページ取得数（1–1000） |
| `COSENSE_SORT_METHOD` | `updated` | ソート方法 |
| `COSENSE_EXCLUDE_PINNED` | `false` | ピン留めページを除外 |

## ライセンス

MIT（フォーク元と同じ）

## クレジット

このフォークは [worldnine/scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp) をベースにしています。フォーク元の充実した実装（7ツール、WebSocket書き込み、142+テスト）がなければ、このプロジェクトは成り立ちませんでした。
