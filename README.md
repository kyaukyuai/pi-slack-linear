# pi-slack-linear

Slack の専用チャンネルを常時監視し、`pi-coding-agent` を使って Linear を task system of record として扱う execution manager bot です。

## What It Does

- 許可済み Slack チャンネルだけを監視する
- 新しい投稿には必ず thread で返信する
- 1 Slack thread = 1 pi session で会話を継続する
- 明確な依頼は自律的に Linear issue 化する
- 複雑な依頼は parent issue + execution-sized child issues に分割する
- owner map に従って自動アサインする
- 期限付きの依頼は due date 付きで Linear issue に反映する
- overdue / stale / blocked / owner・due missing を検知して control room に出す
- internal todo は持たない

## Architecture

```text
Slack (Socket Mode)
  -> custom Node.js bot
  -> pi-coding-agent SDK
  -> manager loops + custom Linear tools + minimal read tool
  -> linear CLI
  -> Linear API
```

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
    intake-ledger.json
    followups.json
    planning-ledger.json
    /sessions/
      /heartbeat/<channel-id>/
      /cron/<job-id>/
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
- `BOT_MODEL`
- `WORKSPACE_DIR`
- `HEARTBEAT_INTERVAL_MIN`
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
- `SCHEDULER_POLL_SEC`
- `LOG_LEVEL`

この bot は `linear-cli v2.4.1` 以上を前提にしています。実行時の Linear 取得・更新は `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, `issue create-batch --file ... --json` を使います。

`LINEAR_WORKSPACE` は固定先の説明用です。`LINEAR_API_KEY` がある場合、`linear-cli v2.4.1` では `-w/--workspace` と併用しないようにしています。

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

`policy.json` と `owner-map.json` は起動時に自動生成されます。初期値では control room を `C0ALAMDRB9V`、fallback owner を `kyaukyuai` に設定します。

`policy.json` では次の manager knobs を調整できます。

- `autoCreate`
- `autoStatusUpdate`
- `followupCooldownHours`
- `reviewExplicitFollowupCount`
- `researchAutoPlanMinActions`
- `researchAutoPlanMaxChildren`

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

`exe.dev` では VM 上で Docker Compose を常駐させるだけで動かせます。手順は [docs/exe-dev-deploy.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/exe-dev-deploy.md) を参照してください。

## Verify

1. 専用チャンネルの通常投稿で bot が thread reply する
2. `タスク追加して` で issue が作られる
3. 複雑な依頼で parent issue + child issues が作られる
4. `明日の会議準備のタスクを追加して` のような依頼で due date が設定される
5. `AIC-2 の期限を 2026-03-20 にして` のような依頼で due date が更新される
6. `09:00`, `17:00`, `Mon 09:30` の review が control room に投稿される
7. heartbeat が overdue / blocked / stale を必要時だけ通知する
8. bot 再起動後も同じ thread では会話が継続する

## Tests

```bash
npm test
```
