# scrapbox-cosense-mcp

[English README](../README.md)

[Cosense (旧 Scrapbox)](https://cosen.se) 用のMCPサーバーです。

## 機能

| ツール | 説明 | 認証 |
|--------|------|:---:|
| `get_page` | ページコンテンツ、メタデータ、リンクを取得 | プライベートプロジェクトのみ |
| `list_pages` | ソート・ページネーション付きでページ一覧を取得（最大1000件） | プライベートプロジェクトのみ |
| `search_pages` | キーワード検索（検索語句ハイライト付き、最大100件） | プライベートプロジェクトのみ |
| `create_page` | WebSocket APIでページを作成（Markdown/Scrapbox本文対応） | 必要 |
| `get_page_url` | ページの直接URLを生成 | 不要 |
| `insert_lines` | ページの指定行の後にテキストを挿入 | 必要 |
| `edit_lines` | 完全一致した行を置換（既定は最初の1件、`matchAll` で全件） | 必要 |
| `delete_page` | 全行を空にしてページを削除（オプトイン制。下記参照） | 必要 |

`create_page` と `insert_lines` と `edit_lines` は `format` パラメータ（`"markdown"` または `"scrapbox"`）でコンテンツ変換を制御できます。

`edit_lines` は既定では最初に一致した行だけを置換します。全件を置換するには `matchAll: true` を指定してください。既定値を控えめにしているのは意図的です。箇条書きの記号だけの行や空行のように、同じ文字列の行がページ内に何度も現れることがあり、それらを一度にすべて置き換えるのは呼び出し側の意図と異なる場合が多いためです。

### `delete_page` はオプトイン制です

`delete_page` は、**`COSENSE_ENABLE_DELETE=true` を設定したときだけ登録されます**。設定していなければツール一覧にも現れないので、エージェントが誤って呼ぶこともありません。このサーバーは共有のMCP設定に入れて使われることも多いため、削除機能は意図的に有効化した利用者にだけ露出させています。

ページの削除は、全ての行を空にすることで行います。Cosenseは全ての行が空になったページを自動的に削除します。取り消しはできません。さらに2つの安全策を入れてあります。

- 対象のページが存在していることを確認します。存在しない場合は、黙って成功せずにエラーを返します。CosenseのREST APIは未作成のページに対してもタイトル行を返すため、行数ではなく `persistent` で判定しています。`create_page` の既存ページ判定と同じやり方です。
- `dryRun: true` を指定すると、削除される行数と冒頭5行を報告するだけで、ページには一切触れません。

プロジェクトごとに複数のインスタンスを動かしている場合は、削除を許すインスタンスにだけこの変数を設定してください。

```json
{
  "mcpServers": {
    "cosense-notes": {
      "command": "npx",
      "args": ["-y", "scrapbox-cosense-mcp"],
      "env": {
        "COSENSE_PROJECT_NAME": "notes",
        "COSENSE_SID": "s:your-session-id",
        "COSENSE_TOOL_SUFFIX": "notes",
        "COSENSE_ENABLE_DELETE": "true"
      }
    },
    "cosense-archive": {
      "command": "npx",
      "args": ["-y", "scrapbox-cosense-mcp"],
      "env": {
        "COSENSE_PROJECT_NAME": "archive",
        "COSENSE_SID": "s:your-session-id",
        "COSENSE_TOOL_SUFFIX": "archive"
      }
    }
  }
}
```

この例では `notes` のインスタンスだけが `delete_page_notes` を持ち、`archive` のインスタンスには削除のツールが現れません。

`insert_lines` と `edit_lines` は、対象の行が見つからなかったときの挙動が異なります。`insert_lines` はページの末尾に追記します。「このテキストをどこかに足す」という要求には、末尾という妥当な着地点があるからです。`edit_lines` はエラーを返し、ページを変更しません。「この特定の行を置き換える」という要求には代わりの着地点がなく、置換内容を末尾に追記してしまえば、呼び出し側が求めていないページが黙って出来上がるためです。

## クイックスタート

### 方法A: Desktop Extension (.mcpb) — 最も簡単

1. [GitHub Releases](https://github.com/worldnine/scrapbox-cosense-mcp/releases) から `scrapbox-cosense-mcp.mcpb` をダウンロード
2. ダブルクリック — Claude Desktopのインストールダイアログが開きます
3. プロジェクト名（プライベートプロジェクトの場合はセッションID）を入力

### 方法B: Claude Code プラグイン

1. マーケットプレイスを追加:
   ```
   /plugin marketplace add worldnine/scrapbox-cosense-mcp
   ```
2. プラグインをインストール:
   ```
   /plugin install scrapbox-cosense@worldnine-scrapbox-cosense-mcp
   ```
   デフォルトでグローバルにインストールされます。`--scope project` や `--scope local` で変更可能。
3. 環境変数を設定:
   ```json
   {
     "env": {
       "COSENSE_PROJECT_NAME": "your_project_name",
       "COSENSE_SID": "your_sid"
     }
   }
   ```
   | ファイル | スコープ |
   |----------|----------|
   | `~/.claude/settings.json` | 全プロジェクト共通（グローバル） |
   | `.claude/settings.local.json` | このプロジェクトのみ（gitignore対象） |

MCPサーバー設定が自動適用され、`/cosense` スキルも利用可能になります。

### 方法C: Claude Code（手動MCP設定）

プラグインを使わず手動で設定する場合:

```bash
claude mcp add scrapbox-cosense-mcp \
  -e COSENSE_PROJECT_NAME=your_project \
  -e COSENSE_SID=your_sid \
  -- npx -y scrapbox-cosense-mcp
```

### 方法D: Claude Desktop / 他のMCPクライアント

設定ファイルに追加してください：

| クライアント | 設定ファイル |
|-------------|-------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%/Claude/claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json`（プロジェクトルート） |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

```json
{
  "mcpServers": {
    "scrapbox-cosense-mcp": {
      "command": "npx",
      "args": ["-y", "scrapbox-cosense-mcp"],
      "env": {
        "COSENSE_PROJECT_NAME": "your_project_name",
        "COSENSE_SID": "your_sid"
      }
    }
  }
}
```

### 方法E: ソースからビルド

```bash
git clone https://github.com/worldnine/scrapbox-cosense-mcp.git
cd scrapbox-cosense-mcp
npm install && npm run build
```

## 環境変数

### 必須

| 変数 | 説明 |
|------|------|
| `COSENSE_PROJECT_NAME` | Scrapbox/Cosenseのプロジェクト名 |
| `COSENSE_SID` | プライベートプロジェクト用のセッションID（`connect.sid` Cookie）— [取得方法](./authentication.md) |

### オプション

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `API_DOMAIN` | `scrapbox.io` | APIドメイン |
| `SERVICE_LABEL` | `cosense (scrapbox)` | ツール説明に表示される名前 |
| `COSENSE_PAGE_LIMIT` | `100` | 初期取得ページ数（1–1000） |
| `COSENSE_SORT_METHOD` | `updated` | 初期ソート順: updated, created, accessed, linked, views, title |
| `COSENSE_TOOL_SUFFIX` | — | 複数インスタンス用のツール名サフィックス（例: `main` → `get_page_main`） |
| `COSENSE_CONVERT_NUMBERED_LISTS` | `false` | Markdown変換時に数字付きリストを箇条書きに変換 |
| `COSENSE_EXCLUDE_PINNED` | `false` | 初期リソース一覧からピン留めページを除外 |
| `COSENSE_ENABLE_DELETE` | `false` | `delete_page` ツールと `delete` サブコマンドを有効にする。設定しなければどちらも使えない |

## 複数プロジェクト対応

すべてのツールでオプションの `projectName` パラメータを指定して、異なるプロジェクトにアクセスできます。異なる認証情報を持つ複数のプライベートプロジェクトには、`COSENSE_TOOL_SUFFIX` を使った複数サーバーインスタンスが推奨です。

詳細は [docs/multiple-projects.md](./multiple-projects.md) を参照してください。

## 開発

| コマンド | 説明 |
|---------|------|
| `npm run build` | ビルド（TypeScript → JavaScript） |
| `npm run watch` | 開発時の自動リビルド |
| `npm test` | テスト実行 |
| `npm run lint` | ESLint実行 |
| `npm run inspector` | MCP Inspectorでデバッグ |

### 貢献ガイドライン

1. `main` から機能ブランチを作成
2. テストを追加して変更を実装
3. `npm run lint && npm test` を実行
4. プルリクエストを作成 — CIが自動実行されます
