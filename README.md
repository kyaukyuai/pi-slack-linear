# cogito-work-manager

Slack の専用チャンネルを常時監視し、必要に応じて Linear issue create webhook も受けながら、`pi-coding-agent` を使って Linear を task system of record として扱う execution manager assistant「コギト」です。

## What It Does

- 許可済み Slack チャンネルだけを監視する
- Optional: Linear issue create webhook を受信して新規 issue の自動処理を行う
- 新しい投稿には必ず thread で返信する
- 1 Slack thread = 1 pi session で会話を継続する
- 明確な依頼は自律的に Linear issue 化する
- 複雑な依頼は parent issue + execution-sized child issues に分割する
- owner map に従って自動アサインする
- 期限付きの依頼は due date 付きで Linear issue に反映する
- overdue / stale / blocked / owner・due missing を検知して control room に出す
- 必要に応じて Notion を参考情報として参照し、指定先にアジェンダ page を作成する
- internal todo は持たない

## Architecture

```text
Slack (Socket Mode) / Linear Issue Create Webhook
  -> custom Node.js bot + webhook listener
  -> pi-coding-agent SDK
  -> manager loops + custom Linear tools + read-only reference tools
  -> linear CLI
  -> Linear API
```

execution manager としての中長期設計方針と、repo 向けの目標ディレクトリ構成は [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/docs/execution-manager-architecture.md) を参照してください。

## Directory Layout

実行時の workspace は次の構成になります。

```text
/workspace
  /.pi/agent/skills/linear-cli/
  /threads/<channel-id>/<thread-ts>/
    session.jsonl
    log.jsonl
    attachments/
    scratch/
  /system/
    HEARTBEAT.md
    jobs.json
    policy.json
    owner-map.json
    followups.json
    planning-ledger.json
    webhook-deliveries.json
    workgraph-events.jsonl
    workgraph-snapshot.json
    /sessions/
      /heartbeat/<channel-id>/
      /cron/<job-id>/
      /webhook/<issue-id>/
```

## Required Environment Variables

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_ALLOWED_CHANNEL_IDS`
- `LINEAR_API_KEY`
- `LINEAR_WORKSPACE`
- `LINEAR_TEAM_KEY`

Optional:

- `ANTHROPIC_API_KEY`
- `LINEAR_WEBHOOK_ENABLED`
- `LINEAR_WEBHOOK_PUBLIC_URL`
- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_WEBHOOK_PORT`
- `LINEAR_WEBHOOK_PATH`
- `NOTION_API_TOKEN`
- `NOTION_AGENDA_PARENT_PAGE_ID`
- `BOT_MODEL`
- `WORKSPACE_DIR`
- `HEARTBEAT_INTERVAL_MIN`
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
- `SCHEDULER_POLL_SEC`
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN`
- `WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS`
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS`
- `LOG_LEVEL`

この bot は `linear-cli v2.8.0` 以上を前提にしています。実行時の Linear 取得・更新は `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, `issue create-batch --file ... --json` を使います。

`NOTION_API_TOKEN` を設定すると、bundled `ntn v0.4.0` を使って Notion を参照できます。現状のスコープでは page search、page facts、page content 抜粋、database search、database query の読み出しに加えて、`NOTION_AGENDA_PARENT_PAGE_ID` を設定すると指定 parent page 配下に agenda page を作成できます。また、既存 page に対しては title 更新と append-only の追記、archive/trash までサポートします。database row の更新・削除はまだ扱いません。Notion は task system of record にはしません。

`LINEAR_WORKSPACE` は固定先の説明用です。`LINEAR_API_KEY` がある場合、`linear-cli v2.8.0` でも `-w/--workspace` と併用しないようにしています。

`LINEAR_WEBHOOK_ENABLED=true` にすると、同一プロセスで issue create webhook listener を起動します。受信対象は `LINEAR_TEAM_KEY` の新規 issue だけで、署名検証と delivery dedupe を行ったうえで、agent-first / strict tools / manager commit の system workflow に載せます。no-op は silent で、action 実行時と failed 時だけ control room に通知します。

webhook を有効にする場合は以下も必要です。

- `LINEAR_WEBHOOK_PUBLIC_URL`
  - Linear から到達できる公開 URL。`LINEAR_WEBHOOK_PATH` をこの末尾に連結して登録します。
- `LINEAR_WEBHOOK_SECRET`
  - webhook 署名検証用の secret。
- `LINEAR_WEBHOOK_PORT`
  - bot が listen する port。docker compose では同 port を host に公開します。
- `LINEAR_WEBHOOK_PATH`
  - default は `/hooks/linear`

`ANTHROPIC_API_KEY` を入れない場合は、手元の `~/.pi/agent/auth.json` を docker compose で `/workspace/.pi/agent/auth.json` に mount して使えます。

## Heartbeat and Scheduler

- `HEARTBEAT_INTERVAL_MIN`
  - `0` なら無効
  - `30` なら 30 分ごとに heartbeat を実行
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
  - 直近何時間に会話があった channel を heartbeat 対象にするか
- `SCHEDULER_POLL_SEC`
  - `jobs.json` を何秒ごとに確認するか

heartbeat は isolated session `heartbeat:<channel>` 相当で動き、返答が `HEARTBEAT_OK` の時は Slack に投稿しません。

scheduler は `/workspace/system/jobs.json` を読み、`at`, `every`, `daily`, `weekly` の job を isolated session `cron:<jobId>` 相当で実行します。初回起動時に、control room 向けの manager review jobs が自動生成されます。

Slack からも scheduler を管理できます。主な例:

- `スケジュール一覧を見せて`
- `manager-review-evening の設定を見せて`
- `毎日 09:00 に AIC の期限近い task を確認する job を追加して`
- `daily-task-check を 17:00 に変更して`
- `daily-task-check を削除して`
- `weekly-notion-agenda-ai-clone を今すぐ実行して`
- `朝レビューを 08:30 に変更して`
- `夕方レビューを止めて`
- `heartbeat を 60分ごとにして`

built-in schedules は `morning-review`, `evening-review`, `weekly-review`, `heartbeat` です。これらは `policy.json` が正で、Slack からの変更も内部的には policy update として反映されます。custom jobs だけが `jobs.json` に直接保存されます。
即時実行 / テスト実行は custom job のみ対応です。built-in review / heartbeat は今回の scope では対象外です。

Slack から既存 issue の実行依頼もできます。主な例:

- `AIC-123 を進めて`
- `この issue を実行して`
- `AIC-123 の次の一手をやって`

この workflow は既存 issue を読んで、AI が今すぐ進める価値がある action だけを既存 manager commit surface で実行します。曖昧な target は code で補完せず、issue ID の補足を求めます。

`jobs.json` の最小例:

```json
[
  {
    "id": "manager-review-morning",
    "enabled": true,
    "channelId": "C0123456789",
    "prompt": "manager review: morning",
    "kind": "daily",
    "time": "09:00",
    "action": "morning-review"
  },
  {
    "id": "manager-review-weekly",
    "enabled": true,
    "channelId": "C0123456789",
    "prompt": "manager review: weekly",
    "kind": "weekly",
    "weekday": "mon",
    "time": "09:30",
    "action": "weekly-review"
  }
]
```

`policy.json` と `owner-map.json` は起動時に自動生成されます。初期値では control room を `C0ALAMDRB9V`、assistant 名を `コギト`、fallback owner を `kyaukyuai` に設定します。

`policy.json` では次の manager knobs を調整できます。

- `autoCreate`
- `assistantName`
- `autoStatusUpdate`
- `followupCooldownHours`
- `reviewExplicitFollowupCount`
- `researchAutoPlanMinActions`
- `researchAutoPlanMaxChildren`
- `reviewCadence.morningEnabled`
- `reviewCadence.eveningEnabled`
- `reviewCadence.weeklyEnabled`
- `heartbeatEnabled`
- `heartbeatIntervalMin`
- `heartbeatActiveLookbackHours`

## Slack App Setup

最低限これを設定します。

### Bot Token Scopes

- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `groups:history`
- `groups:read`

### Bot Events

- `message.channels`
- `message.groups`

### Other

- Socket Mode を ON
- App-Level Token に `connections:write`
- bot を専用チャンネルへ `/invite`

DM は v1 では使いません。

## Local Development

```bash
cp .env.example .env
npm install
npm run dev
```

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

## Deploy to exe.dev

`exe.dev` では VM 上で Docker Compose を常駐させるだけで動かせます。Linear webhook を使う場合は追加で public proxy が必要です。手順は [docs/exe-dev-deploy.md](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/docs/exe-dev-deploy.md) を参照してください。

## Verify

1. 専用チャンネルの通常投稿で bot が thread reply する
2. `タスク追加して` で issue が作られる
3. 複雑な依頼で parent issue + child issues が作られる
4. `明日の会議準備のタスクを追加して` のような依頼で due date が設定される
5. `AIC-2 の期限を 2026-03-20 にして` のような依頼で due date が更新される
6. `09:00`, `17:00`, `Mon 09:30` の review が control room に投稿される
7. heartbeat が overdue / blocked / stale を必要時だけ通知する
8. bot 再起動後も同じ thread では会話が継続する
9. Optional: Linear で AIC issue を新規作成すると、必要な自動処理だけが control room に通知される

## Tests

```bash
npm test
```

## Operator Diagnostics

thread の解釈を確認する場合:

```bash
npm run manager:diagnostics -- thread C0ALAMDRB9V 1773806473.747499 /workspace
```

issue の context を確認する場合:

```bash
npm run manager:diagnostics -- issue AIC-38 /workspace
```

直近 webhook delivery を確認する場合:

```bash
npm run manager:diagnostics -- webhook /workspace
```
