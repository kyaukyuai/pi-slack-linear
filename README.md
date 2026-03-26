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
    AGENTS.md
    MEMORY.md
    AGENDA_TEMPLATE.md
    jobs.json
    job-status.json
    policy.json
    owner-map.json
    notion-pages.json
    followups.json
    planning-ledger.json
    personalization-ledger.json
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
- `BOT_THINKING_LEVEL`
- `BOT_MAX_OUTPUT_TOKENS`
- `BOT_RETRY_MAX_RETRIES`
- `BOT_UID`
- `BOT_GID`
- `WORKSPACE_DIR`
- `HEARTBEAT_INTERVAL_MIN`
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
- `SCHEDULER_POLL_SEC`
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN`
- `WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS`
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS`
- `LOG_LEVEL`

この bot は `linear-cli v2.8.0` 以上を前提にしています。実行時の Linear 取得・更新は `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, `issue create-batch --file ... --json` を使います。

`NOTION_API_TOKEN` を設定すると、bundled `ntn v0.4.0` を使って Notion を参照できます。現状のスコープでは page search、page facts、page content 抜粋、database search、database query の読み出しに加えて、`NOTION_AGENDA_PARENT_PAGE_ID` を設定すると指定 parent page 配下に agenda page を作成できます。また、既存 page に対しては title 更新、append 追記、Cogito 管理ページに限定した heading_2 単位の `replace_section` 更新、archive/trash までサポートします。管理対象ページは `workspace/system/notion-pages.json` に登録された page です。database row の更新・削除はまだ扱いません。Notion は task system of record にはしません。

`/workspace/system/AGENTS.md`, `/workspace/system/MEMORY.md`, `/workspace/system/AGENDA_TEMPLATE.md` は利用者ごとの runtime customization 用です。`AGENTS.md` には安定した進め方、返信方針、優先順位のような operating rules を置き、`MEMORY.md` には用語や背景知識だけでなく、プロジェクト概要、メンバーと役割、ロードマップ、主要マイルストーンのような project knowledge を置きます。`MEMORY.md` のスケジュール情報は milestone-only で扱い、issue 単位の期限、現在の進捗、current status は入れません。`AGENTS.md` と `MEMORY.md` は manager/system turn に加えて reply/router/intake/research/follow-up planner にも毎 turn 注入されます。ただし schema、supported actions、parser contract、safety rule は上書きしません。`AGENDA_TEMPLATE.md` は Notion アジェンダの既定構成専用で、Notion agenda の作成・更新に関係する manager/system turn にだけ注入されます。`HEARTBEAT.md` は heartbeat system turn の prompt override、`owner-map.json` は owner routing 用の control-plane config です。repo ルートの `AGENTS.md` は開発ルール用であり、runtime customization には使いません。

runtime `AGENTS.md` / `MEMORY.md` は会話や実行結果から silent auto-update されます。抽出候補は `/workspace/system/personalization-ledger.json` に保存され、昇格したものだけ runtime `AGENTS.md` / `MEMORY.md` に反映されます。rich な project snapshot を保存したい場合は、`MEMORY に保存して` を明示して `project-overview / members-and-roles / roadmap-and-milestones` を含む structured save を使うのが主経路です。

`LINEAR_WORKSPACE` は固定先の説明用です。`LINEAR_API_KEY` がある場合、`linear-cli v2.8.0` でも `-w/--workspace` と併用しないようにしています。

`LINEAR_WEBHOOK_ENABLED=true` にすると、同一プロセスで issue create webhook listener を起動します。受信対象は `LINEAR_TEAM_KEY` の新規 issue だけで、署名検証と delivery dedupe を行ったうえで、agent-first / strict tools / manager commit の system workflow に載せます。判定基準は「価値があるか」ではなく「既存 proposal surface で今すぐ安全に実行できる action があるか」です。no-op は silent で、action 実行時と failed 時だけ control room に通知します。

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

LLM runtime は env で global に設定できます。

- `BOT_MODEL`
  - `ModelRegistry.find("anthropic", BOT_MODEL)` で解決する model id。
- `BOT_THINKING_LEVEL`
  - `off | minimal | low | medium | high | xhigh`
  - reasoning 対応 model では provider の reasoning / thinking 設定に変換されます。
- `BOT_MAX_OUTPUT_TOKENS`
  - 未指定なら library/provider default を使います。
  - 指定した場合は repo 側の stream wrapper で every LLM call に `maxTokens` / `max_tokens` として反映します。
- `BOT_RETRY_MAX_RETRIES`
  - SDK retry settings の `retry.maxRetries` に入ります。
- `BOT_UID` / `BOT_GID`
  - Docker bind mount 上の runtime files を host user 所有にそろえるための uid/gid です。
  - docker compose 運用では host の `id -u` / `id -g` を入れてください。
  - 起動時に `/workspace/system` と `/workspace/threads` をこの uid/gid に寄せ、その後の bot 実行も同じ uid/gid に落とします。

現状の Anthropic runtime では `sessionId` は agent までは渡りますが provider request には使われません。`temperature` と `cacheRetention` は現在 read-only で、repo 側からは設定していません。

## Heartbeat and Scheduler

- `HEARTBEAT_INTERVAL_MIN`
  - `0` なら無効
  - `30` なら 30 分ごとに heartbeat を実行
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
  - 直近何時間に会話があった channel を heartbeat 対象にするか
- `SCHEDULER_POLL_SEC`
  - scheduler runtime state を何秒ごとに確認するか

heartbeat は isolated session `heartbeat:<channel>` 相当で動き、返答が `HEARTBEAT_OK` の時は Slack に投稿しません。

scheduler は `/workspace/system/jobs.json` の custom job 定義、`/workspace/system/job-status.json` の runtime status、`policy.json` 由来の built-in review schedule を合わせて読み、`at`, `every`, `daily`, `weekly` の job を isolated session `cron:<jobId>` 相当で実行します。

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

built-in schedules は `morning-review`, `evening-review`, `weekly-review`, `heartbeat` です。これらは `policy.json` が正で、Slack からの変更も内部的には policy update として反映されます。custom jobs だけが `jobs.json` に保存され、`nextRunAt` / `lastRunAt` / `lastStatus` / `lastResult` / `lastError` は `job-status.json` に保存されます。
即時実行 / テスト実行は custom job のみ対応です。built-in review / heartbeat は今回の scope では対象外です。

Slack から既存 issue の実行依頼もできます。主な例:

- `AIC-123 を進めて`
- `この issue を実行して`
- `AIC-123 の次の一手をやって`

この workflow は既存 issue を読んで、AI が今すぐ安全に実行できる action だけを既存 manager commit surface で実行します。曖昧な target は code で補完せず、issue ID の補足を求めます。

`jobs.json` の最小例:

```json
[
  {
    "id": "daily-task-check",
    "enabled": true,
    "channelId": "C0123456789",
    "prompt": "AIC の期限近い task を確認する",
    "kind": "daily",
    "time": "09:00"
  }
]
```

`policy.json` と `owner-map.json` は起動時に自動生成されます。初期値では control room を `C0ALAMDRB9V`、assistant 名を `コギト`、fallback owner を `kyaukyuai` に設定します。あわせて空の runtime `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`, `jobs.json`, `job-status.json`, `personalization-ledger.json` も生成されます。用途は固定スロット方式で、`AGENTS.md` は全 planner 共通の operating rules、`MEMORY.md` は全 planner 共通の project knowledge / terminology / durable context、`AGENDA_TEMPLATE.md` は Notion agenda 専用です。`BOT_UID` / `BOT_GID` を設定している場合、これらの runtime system files は host 側 operator が `sudo` なしで編集できる owner に保たれます。

runtime state file の大まかな扱いは次の 3 分類です。

- `editable`: `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `policy.json`, `owner-map.json`, `jobs.json`
- `internal`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `derived`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

`editable` は operator が直接編集できます。`internal` は system-maintained ledger / registry なので基本は閲覧専用、`derived` は生成物なので recovery / diagnostics を使って扱い、手編集しません。

更新方針は別軸で見ます。

- `silent-auto-update`: `AGENTS.md`, `MEMORY.md`
- `explicit-slack-update`: `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `owner-map.json`
- `manager-commit-only`: `policy.json`, `jobs.json`
- `system-maintained`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `rebuild-only`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

意味:

- `silent-auto-update`: 高信頼時に system が自律更新してよい
- `explicit-slack-update`: silent update はせず、Slack の明示依頼 + manager commit 経由でのみ更新する
- `manager-commit-only`: typed proposal と manager commit 経由でのみ自動更新する
- `system-maintained`: runtime が通常処理の中で直接保守する
- `rebuild-only`: generated state なので edit せず recovery / rebuild で扱う

`policy.json` では次の manager knobs を調整できます。

- `autoCreate`
- `assistantName`
- `autoStatusUpdate`
- `followupCooldownHours`
- `reviewExplicitFollowupCount`
- `mentionOnFirstFollowupCategories`
- `mentionOnRepingCategories`
- `mentionAfterRepingCount`
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

`manager:diagnostics` は app 本体と同じく repo の `.env` を読みます。host で見るときは `./workspace`、Docker container / `exe.dev` では `/workspace` を使ってください。

thread の解釈を確認する場合:

```bash
npm run manager:diagnostics -- thread C0ALAMDRB9V 1773806473.747499 ./workspace
```

issue の context を確認する場合:

```bash
npm run manager:diagnostics -- issue AIC-38 ./workspace
```

直近 webhook delivery を確認する場合:

```bash
npm run manager:diagnostics -- webhook ./workspace
```

runtime state file の分類と編集可否を確認する場合:

```bash
npm run manager:diagnostics -- state-files ./workspace
```

runtime personalization の ledger と現在の `AGENTS.md` / `MEMORY.md` を確認する場合:

```bash
npm run manager:diagnostics -- personalization ./workspace
```

`MEMORY.md` の project coverage と current-state 混入 warning を確認する場合:

```bash
npm run manager:diagnostics -- memory ./workspace
```

現在の LLM runtime config と provider payload preview を確認する場合:

```bash
npm run manager:diagnostics -- llm ./workspace
```

`ANTHROPIC_API_KEY` があれば `authSource.source` は `runtime-override`、それが無く `workspace/.pi/agent/auth.json` を使う場合は `auth-storage` になります。local と `exe.dev` の差分確認では `configured.model`, `configured.thinkingLevel`, `configured.maxOutputTokens`, `configured.retryMaxRetries`, `authSource.source` を見比べてください。
