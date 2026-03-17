# pi-slack-linear

Slack の専用チャンネルを常時監視し、`pi-coding-agent` を使って Linear を task system of record として扱うボットです。

## What It Does

- 許可済み Slack チャンネルだけを監視する
- 新しい投稿には必ず thread で返信する
- 1 Slack thread = 1 pi session で会話を継続する
- 明示的なタスク依頼だけ Linear issue を create/list/update する
- internal todo は持たない

## Architecture

```text
Slack (Socket Mode)
  -> custom Node.js bot
  -> pi-coding-agent SDK
  -> custom Linear tools + minimal read tool
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
- `LOG_LEVEL`

`LINEAR_WORKSPACE` は固定先の説明用です。`LINEAR_API_KEY` がある場合、current `linear-cli` では `-w/--workspace` と併用しないようにしています。

`ANTHROPIC_API_KEY` を入れない場合は、手元の `~/.pi/agent/auth.json` を docker compose で `/workspace/.pi/agent/auth.json` に mount して使えます。

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
3. `タスク確認して` で active issue が返る
4. `完了にして` で issue が completed へ動く
5. bot 再起動後も同じ thread では会話が継続する

## Tests

```bash
npm test
```
