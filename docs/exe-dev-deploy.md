# Deploying `pi-slack-linear` on `exe.dev`

この bot は Slack Socket Mode を使うため、外部から受ける Webhook は不要です。`exe.dev` では VM 上で Docker Compose を常駐させるだけで動かせます。

## Overview

- VM: `exe.dev` の `exeuntu` VM
- Runtime: Docker Compose
- Persistent data: repo 配下の `./workspace`
- Outbound integrations:
  - Slack Socket Mode
  - Anthropic
  - Linear API
  - Optional: Notion API
- Bundled CLI: `linear-cli v2.7.0`

`exe.dev` の HTTP proxy は必須ではありません。この bot は常駐 daemon として動けば十分です。

## Prerequisites

手元で以下を用意しておきます。

- `ssh exe.dev` でログイン済み
- Slack App
  - `SLACK_APP_TOKEN`
  - `SLACK_BOT_TOKEN`
- Linear
  - `LINEAR_API_KEY`
  - `LINEAR_WORKSPACE`
  - `LINEAR_TEAM_KEY`
- Optional: Notion
  - `NOTION_API_TOKEN`
- Anthropic
  - 推奨: `ANTHROPIC_API_KEY`
  - 代替: `~/.pi/agent/auth.json`

## 1. Create a VM

新しい VM を作ります。

```bash
ssh exe.dev new --name pi-linear-bot
```

作成後、SSH で入ります。

```bash
ssh pi-linear-bot.exe.xyz
```

## 2. Clone the repo

VM 内で repo を配置します。

```bash
git clone https://github.com/kyaukyuai/pi-slack-linear.git
cd pi-slack-linear
```

private repo の場合は `gh auth login` か deploy key を使ってください。

## 3. Prepare environment variables

example から `.env` を作ります。

```bash
cp .env.example .env
```

`.env` に最低限これを入れます。

```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALLOWED_CHANNEL_IDS=C0ALAMDRB9V
LINEAR_API_KEY=lin_api_...
LINEAR_WORKSPACE=kyaukyuai
LINEAR_TEAM_KEY=AIC
ANTHROPIC_API_KEY=sk-ant-...
BOT_MODEL=claude-sonnet-4-6
WORKSPACE_DIR=/workspace
HEARTBEAT_INTERVAL_MIN=30
HEARTBEAT_ACTIVE_LOOKBACK_HOURS=24
SCHEDULER_POLL_SEC=30
WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15
WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS=200
WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS=500
LOG_LEVEL=info
NOTION_API_TOKEN=secret_...
```

補足:

- `SLACK_ALLOWED_CHANNEL_IDS` はカンマ区切りで複数指定できます。
- `LINEAR_TEAM_KEY` は UUID ではなく `AIC`, `KYA` のような team key を使います。
- `NOTION_API_TOKEN` を入れると bundled `ntn v0.4.0` で Notion page search / page facts / page content excerpt / database search / database query の read-only tool が使えます。
- headless 運用では `ANTHROPIC_API_KEY` を推奨します。
- manager review と heartbeat を既定で使うなら `HEARTBEAT_INTERVAL_MIN=30` のままにします。
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15` なら 15 分ごとに health check と auto compaction 判定を行います。
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS` に達すると active `workgraph-events.jsonl` を snapshot に畳み込みます。

## 4. Optional: use `auth.json` instead of `ANTHROPIC_API_KEY`

`ANTHROPIC_API_KEY` を使わない場合だけ、手元の `auth.json` を VM にコピーします。

ローカルから:

```bash
scp ~/.pi/agent/auth.json pi-linear-bot.exe.xyz:/home/exedev/pi-slack-linear/.pi-auth.json
```

VM 内で:

```bash
mkdir -p workspace/.pi/agent
cp .pi-auth.json workspace/.pi/agent/auth.json
chmod 600 workspace/.pi/agent/auth.json
```

この方式は OAuth の期限切れに影響されるので、長期運用では API key の方が安定します。

## 5. Start the bot

Compose で起動します。

```bash
docker compose up -d --build
```

この image は `linear-cli v2.7.0` と `ntn v0.4.0` を同梱します。Linear では `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, `issue create-batch --file ... --json` を前提に動きます。Notion は page search / page facts / page content excerpt / database search / database query の read-only reference fetch に限定しています。

ログ確認:

```bash
docker compose logs -f
```

正常なら次のようなログが出ます。

- `Slack assistant starting`
- `Slack assistant connected`

## 6. Verify in Slack

許可済みチャンネルで試します。メンションは不要です。

通常会話:

```text
こんにちは
```

自律起票:

```text
明日の田平さんとの会議準備のタスクを追加して
```

複雑依頼の分割:

```text
- ログイン画面の不具合を調査する
- API 側の原因を確認する
- 修正方針をまとめる
```

一覧:

```text
タスク確認して
```

完了:

```text
AIC-2 を完了にして
```

期限変更:

```text
AIC-2 の期限を 2026-03-20 にして
```

期待する挙動:

- bot は thread で返信する
- 明確な依頼は Linear に自律起票される
- 複雑な依頼は parent issue + child issues へ分割される
- relative date を含む依頼では due date が設定される
- `タスク確認` は active issue を返す
- 同じ Slack thread では会話が継続する
- `09:00`, `17:00`, `Mon 09:30` に manager review jobs が自動で動く

## 7. Restart and updates

コード更新:

```bash
git pull
docker compose up -d --build
```

停止:

```bash
docker compose down
```

## 8. Manager system files

起動すると `/workspace/system` に manager 用ファイルが自動生成されます。

- `policy.json`
- `owner-map.json`
- `followups.json`
- `planning-ledger.json`
- `workgraph-events.jsonl`
- `workgraph-snapshot.json`
- `jobs.json`
- `HEARTBEAT.md`

このうち、明示的に編集したくなるのは主に `policy.json`, `owner-map.json`, `HEARTBEAT.md` です。

## 9. Workgraph maintenance

現在の health を確認する場合:

```bash
npm run workgraph:health -- /workspace
```

snapshot だけ作り直す場合:

```bash
npm run workgraph:snapshot -- /workspace
```

event log を snapshot に畳み込んで active log を空にする場合:

```bash
npm run workgraph:compact -- /workspace
```

thread の解釈や issue context を確認する場合:

```bash
npm run manager:diagnostics -- thread C0ALAMDRB9V 1773806473.747499 /workspace
npm run manager:diagnostics -- issue AIC-38 /workspace
```

replay recovery 手順:

1. bot を止める

```bash
docker compose down
```

2. 現在の workgraph files を退避する

```bash
cp workspace/system/workgraph-events.jsonl workspace/system/workgraph-events.jsonl.bak
cp workspace/system/workgraph-snapshot.json workspace/system/workgraph-snapshot.json.bak
```

3. active `workgraph-events.jsonl` を replay して snapshot を再生成する

```bash
npm run workgraph:recover -- /workspace
```

4. bot を起動してログを確認する

```bash
docker compose up -d --build
docker compose logs --tail 20 bot
```

注意:

- `workgraph:recover` は現在の `workgraph-events.jsonl` を replay して fresh snapshot を作る
- 既に `workgraph:compact` 済みで active log が空の場合、recovery に必要なのは `workgraph-snapshot.json` 側であり、pre-compact の log backup がないと full replay はできない
- recovery 後に `Slack assistant connected` が出ることを確認する

例:

```bash
mkdir -p workspace/system
cat > workspace/system/HEARTBEAT.md <<'EOF'
You are running a periodic heartbeat for this Slack channel.
Check active Linear issues and only report one short actionable update.
If nothing is worth posting, reply exactly HEARTBEAT_OK.
EOF
```

```bash
cat > workspace/system/jobs.json <<'EOF'
[
  {
    "id": "manager-review-morning",
    "enabled": true,
    "channelId": "C0ALAMDRB9V",
    "prompt": "manager review: morning",
    "kind": "daily",
    "time": "09:00",
    "action": "morning-review"
  }
]
EOF
```

## 9. Optional: run on boot

`restart: unless-stopped` を入れているので、Docker daemon 再起動後は container も復帰します。明示的に host 起動時の制御を増やしたいなら `systemd` で `docker compose up -d` を包んでも構いませんが、v1 では必須ではありません。

## 10. Notes on `exe.dev`

- `exe.dev` は VM なので Docker をそのまま使えます。
- public HTTP proxy は不要です。Slack Socket Mode は outbound 接続だけで動きます。
- もし別途 web UI や health endpoint を出すなら、`3000-9999` の port を `exe.dev` proxy に載せられます。
