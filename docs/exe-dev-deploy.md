# Deploying `cogito-work-manager` on `exe.dev`

この bot は Slack Socket Mode だけでも動きますが、Linear issue create webhook を使う場合は追加で public HTTP endpoint が必要です。`exe.dev` では VM 上で Docker Compose を常駐させ、必要なら公開 proxy から webhook port へ流します。

## Overview

- VM: `exe.dev` の `exeuntu` VM
- Runtime: Docker Compose
- Persistent data: repo 配下の `./workspace`
- Outbound integrations:
  - Slack Socket Mode
  - Anthropic
  - Linear API
  - Optional: Notion API
  - Optional: Linear webhook registration
- Bundled CLI: `linear-cli v2.8.0`

`exe.dev` の HTTP proxy は Slack Socket Mode だけなら不要です。Linear webhook を有効にする場合だけ、`LINEAR_WEBHOOK_PUBLIC_URL` が到達するように VM 上の `LINEAR_WEBHOOK_PORT` へ公開経路を用意してください。

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
  - Optional webhook
    - `LINEAR_WEBHOOK_ENABLED`
    - `LINEAR_WEBHOOK_PUBLIC_URL`
    - `LINEAR_WEBHOOK_SECRET`
    - `LINEAR_WEBHOOK_PORT`
    - `LINEAR_WEBHOOK_PATH`
- Optional: Notion
  - `NOTION_API_TOKEN`
  - `NOTION_AGENDA_PARENT_PAGE_ID`
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
git clone https://github.com/kyaukyuai/cogito-work-manager.git
cd cogito-work-manager
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
LINEAR_WEBHOOK_ENABLED=false
LINEAR_WEBHOOK_PUBLIC_URL=https://example.com
LINEAR_WEBHOOK_SECRET=replace-with-long-random-secret
LINEAR_WEBHOOK_PORT=8787
LINEAR_WEBHOOK_PATH=/hooks/linear
ANTHROPIC_API_KEY=sk-ant-...
BOT_MODEL=claude-sonnet-4-6
BOT_THINKING_LEVEL=minimal
BOT_MAX_OUTPUT_TOKENS=
BOT_RETRY_MAX_RETRIES=1
BOT_UID=1000
BOT_GID=1000
WORKSPACE_DIR=/workspace
HEARTBEAT_INTERVAL_MIN=30
HEARTBEAT_ACTIVE_LOOKBACK_HOURS=24
SCHEDULER_POLL_SEC=30
WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15
WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS=200
WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS=500
LOG_LEVEL=info
NOTION_API_TOKEN=secret_...
NOTION_AGENDA_PARENT_PAGE_ID=notion-page-id-...
```

補足:

- `SLACK_ALLOWED_CHANNEL_IDS` はカンマ区切りで複数指定できます。
- `LINEAR_TEAM_KEY` は UUID ではなく `AIC`, `KYA` のような team key を使います。
- `NOTION_API_TOKEN` を入れると bundled `ntn v0.4.0` で Notion page search / page facts / page content excerpt / database search / database query が使えます。
- `NOTION_AGENDA_PARENT_PAGE_ID` を追加すると、その parent page 配下に agenda page を作成できます。
- 既存 Notion page への title 更新、append の追記、Cogito 管理ページに限定した heading_2 単位の `replace_section` 更新、archive/trash も Slack から扱えます。database row の更新・削除は未対応です。
- `/workspace/system/AGENTS.md` には安定した進め方や返信方針のような operating rules を書けます。manager/system turn に加えて reply/router/intake/research/follow-up planner に毎 turn 注入されます。ただし schema や safety rule は上書きしません。
- `/workspace/system/MEMORY.md` には用語、背景知識、個別の好みだけでなく、プロジェクト概要、メンバーと役割、ロードマップ、主要マイルストーンのような project knowledge を書けます。これも manager/system turn に加えて reply/router/intake/research/follow-up planner に毎 turn 注入されます。issue 単位の期限や current status は入れず、スケジュールは milestone-only で扱います。
- `/workspace/system/AGENDA_TEMPLATE.md` に agenda の既定構成を書いておくと、Notion agenda 作成・更新に関係する manager/system turn だけに注入されます。
- runtime `AGENTS.md` / `MEMORY.md` は silent auto-update 対象で、候補は `/workspace/system/personalization-ledger.json` に残ります。rich な project snapshot は `MEMORY に保存して` の明示依頼を主経路にし、silent 側は高信頼な project fact を少数だけ昇格させます。
- repo ルートの `AGENTS.md` は開発ルール用で、runtime customization には使いません。
- `LINEAR_WEBHOOK_ENABLED=true` の場合は、`LINEAR_WEBHOOK_PUBLIC_URL` と `LINEAR_WEBHOOK_SECRET` が必須です。
- webhook listener は `LINEAR_WEBHOOK_PORT` / `LINEAR_WEBHOOK_PATH` で待ち受けます。Compose では同 port を host に公開します。
- Linear webhook の対象は `Issue create` のみです。判定基準は「AI にできる action があるか」で、no-op は silent、action/failed のみ control room に通知します。
- headless 運用では `ANTHROPIC_API_KEY` を推奨します。
- `BOT_THINKING_LEVEL` は `off | minimal | low | medium | high | xhigh` を受け付けます。
- `BOT_MAX_OUTPUT_TOKENS` を入れると、repo 側の stream wrapper で every LLM call に `maxTokens` を注入します。未指定なら library/provider default のままです。
- `BOT_RETRY_MAX_RETRIES` は SDK retry settings の `maxRetries` に対応します。
- `BOT_UID` / `BOT_GID` は Docker bind mount 上の runtime files を host user 所有にそろえるための uid/gid です。`exe.dev` の `exedev` は通常 `1000:1000` です。ローカル Docker 運用では `id -u` / `id -g` の値を入れてください。
- manager review と heartbeat を既定で使うなら `HEARTBEAT_INTERVAL_MIN=30` のままにします。
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15` なら 15 分ごとに health check と auto compaction 判定を行います。
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS` に達すると active `workgraph-events.jsonl` を snapshot に畳み込みます。

## 4. Optional: use `auth.json` instead of `ANTHROPIC_API_KEY`

`ANTHROPIC_API_KEY` を使わない場合だけ、手元の `auth.json` を VM にコピーします。

ローカルから:

```bash
scp ~/.pi/agent/auth.json pi-linear-bot.exe.xyz:/home/exedev/cogito-work-manager/.pi-auth.json
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

この image は `linear-cli v2.8.0` と `ntn v0.4.0` を同梱します。Linear では `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, `issue create-batch --file ... --json`, `webhook list/create/update --json` を前提に動きます。Notion は page search / page facts / page content excerpt / database search / database query の参照に加えて、設定済み parent page 配下への agenda page 作成、既存 page の title 更新、append 追記、Cogito 管理ページに限定した heading_2 単位の `replace_section` 更新、archive/trash をサポートします。

ログ確認:

```bash
docker compose logs -f
```

正常なら次のようなログが出ます。

- `Slack assistant starting`
- `Slack assistant connected`
- Optional: `Linear issue-created webhook reconciled`
- Optional: `Linear webhook listener started`

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
- Optional: Linear で AIC issue を新規作成すると、必要な自動処理だけが control room に通知される

## 7. Restart and updates

コード更新:

```bash
git pull
docker compose up -d --build
```

`BOT_UID` / `BOT_GID` を設定している場合、container は起動時に `/workspace/system` と `/workspace/threads` をその uid/gid に寄せてから bot を同じ uid/gid で実行します。以前の deploy で root 所有になっていた runtime files も、この再起動で通常運用向け owner に戻せます。

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
- `job-status.json`
- `HEARTBEAT.md`
- `AGENTS.md`
- `MEMORY.md`
- `AGENDA_TEMPLATE.md`
- `notion-pages.json`
- `personalization-ledger.json`
- `webhook-deliveries.json`
- `sessions/`

分類の目安:

- `editable`: `policy.json`, `owner-map.json`, `jobs.json`, `HEARTBEAT.md`, runtime `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`
- `internal`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `derived`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

`editable` は operator が直接編集できます。`internal` は system ledger / registry なので基本は閲覧専用、`derived` は生成物なので手編集しません。

更新方針は別軸で見ます。

- `silent-auto-update`: runtime `AGENTS.md`, `MEMORY.md`
- `explicit-slack-update`: `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `owner-map.json`
- `manager-commit-only`: `policy.json`, `jobs.json`
- `system-maintained`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `rebuild-only`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

`explicit-slack-update` は silent update を許しません。`AGENDA_TEMPLATE.md` と `HEARTBEAT.md` は Slack で明示依頼された全文置換だけを manager commit で反映し、`owner-map.json` は structured proposal + preview/confirm を通して更新します。

`BOT_UID` / `BOT_GID` が正しく設定されていれば、これらの files は host 側 operator が `sudo` なしで編集できる owner に保たれます。

`policy.json` では follow-up mention 条件も調整できます。既定では `blocked / overdue / due_today / due_soon` を初回から mention し、`stale / owner_missing` は 1 回 unresolved の再通知から mention します。

Slack から scheduler を操作する場合は、通常こちらを優先します。例:

- `スケジュール一覧を見せて`
- `manager-review-evening の設定を見せて`
- `毎日 09:00 に AIC の期限近い task を確認する job を追加して`
- `daily-task-check を 17:00 に変更して`
- `daily-task-check を削除して`
- `weekly-notion-agenda-ai-clone を今すぐ実行して`
- `朝レビューを 08:30 に変更して`
- `夕方レビューを止めて`
- `heartbeat を 60分ごとにして`

補足:

- built-in review / heartbeat は `policy.json` が正です
- custom job だけが `jobs.json` に保存されます
- `nextRunAt` / `lastRunAt` / `lastStatus` / `lastResult` / `lastError` は `job-status.json` に保存されます
- built-in の `削除` は内部的には `disable` として扱います
- built-in review / heartbeat の即時実行は今回の scope では未対応です

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
npm run manager:diagnostics -- webhook /workspace
npm run manager:diagnostics -- state-files /workspace
npm run manager:diagnostics -- personalization /workspace
npm run manager:diagnostics -- memory /workspace
npm run manager:diagnostics -- llm /workspace
```

`manager:diagnostics` は repo の `.env` を読んで app 本体と同じ runtime config を組み立てます。`ANTHROPIC_API_KEY` が入っていれば `authSource.source=runtime-override`、未設定で `/workspace/.pi/agent/auth.json` を使う場合は `authSource.source=auth-storage` です。

local と `exe.dev` の差分確認手順:

1. local host では `npm run manager:diagnostics -- llm ./workspace` を実行する
2. `exe.dev` では `npm run manager:diagnostics -- llm /workspace` を実行する
3. `configured.model`, `configured.thinkingLevel`, `configured.maxOutputTokens`, `configured.retryMaxRetries`, `authSource.source` を比較する
4. 差分が残る場合は `.env`, Docker / VM の credential 配置, `auth.json` 利用有無のどれが原因かを確認する

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
    "id": "daily-task-check",
    "enabled": true,
    "channelId": "C0ALAMDRB9V",
    "prompt": "AIC の期限近い task を確認する",
    "kind": "daily",
    "time": "09:00"
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
