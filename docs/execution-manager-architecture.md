# Execution Manager Architecture

`cogito-work-manager` を今後「Slack 上の会話 bot」ではなく「Linear を system of record とする execution manager」として進化させるための設計方針をまとめる。

この文書では skill 依存は前提にしない。runtime の主役は agent + tool contracts とし、状態管理と副作用実行は manager commit で担保する。

## Current Status

- 2026-03-19 時点で、planner 分離、workflow 分離、repository 化、unified work graph 導入は `main` で完了している
- 現在の本体 workflow は `workgraph` を primary read model として扱い、Linear を work の source of truth とする
- 2026-03-19 時点で、Slack message / query / create / update の primary path は `pi-coding-agent + strict tools + manager commit` に移行している
- 2026-03-24 時点で、Linear issue create webhook も同じ `agent + strict tools + manager commit` の system workflow に載せられる
- scheduler / heartbeat も同じ agent/tool surface を primary path とし、旧 planner / regex / review builder は emergency fallback に縮退している
- primary path の business judgment は agent proposal に必須化し、manager commit は validation / dedupe / execution / state 更新だけを担当する
- emergency fallback は safety-only とし、旧 heuristics を primary path の代替判断としては使わない
- 今後の主題は大規模 refactor の継続ではなく、運用耐性、可観測性、event log の保守性改善である

## Goals

- Slack や webhook 由来の依頼を安定して work item に変換する
- work item の進捗、blocked、research、follow-up を一貫した状態モデルで扱う
- Linear への作成、更新、コメント、アサインを安全に実行する
- LLM を使っても挙動の契約を維持し、回帰テストできるようにする
- control room review や heartbeat を execution manager の同じモデル上で運用する

## Non-Goals

- 本番処理の中核を skill や自由文 prompt に寄せること
- Linear 以外の独自 todo system を持つこと
- すべての判断を単一の巨大 agent turn に委ねること

## Core Principles

### 1. Agent-First, Tool-Contract-First

LLM/agent は次のような「理解と提案」に使う。

- 会話 / query / create / update / review の intent 解釈
- tool を使った Slack / Linear / workgraph の read
- business command proposal の組み立て
- Slack reply の自然文生成

一方で、次のような「副作用」は必ず manager commit がコードで実行する。

- Linear issue 作成
- due date 更新
- assignee 更新
- comment 追加
- blocked / completed の状態変更
- duplicate 防止
- command validation
- permission / policy check
- workgraph append

この分離により、agent の自然言語理解を活かしつつ、外部副作用は typed contract と idempotent commit で制御できる。

### 2. State-First, Not Chat-First

1 Slack thread = 1 会話コンテキストは維持するが、execution manager の中核は thread ではなく work graph に置く。

最低限、以下を同じモデルで追跡できる必要がある。

- source thread
- source webhook delivery
- parent issue
- child issues
- research issue
- follow-up requests
- blocked reasons
- owner / due-date resolution history

Slack thread は入力チャネルであり、状態の主語ではない。

### 3. Typed Tool Contracts

agent は自由文のまま副作用を起こさない。read / proposal / internal commit の tool contract を通して実行面を固定する。

例:

- `linear_list_active_issues`
- `linear_list_active_issue_facts`
- `linear_get_issue_facts`
- `linear_list_review_facts`
- `workgraph_get_thread_context`
- `propose_create_issue`
- `propose_update_issue_status`
- `propose_review_followup`

agent は proposal までを返し、manager commit が schema validate と execution を引き受ける。

### 4. Idempotent Commands and Append-Only History

Slack の再送、同一 thread の追記、scheduler の再実行があっても、同じ副作用を重複実行しない設計にする。

そのために必要なのは次の 3 点。

- command 実行前に十分な dedupe key を持つこと
- proposal を manager commit で 1 回だけ確定すること
- 実行結果を append-only な履歴として残し、projection で現在状態を作ること

現状の ledger はこの方向の第一歩だが、workflow ごとに分断されている。

### 5. Linear Is the Source of Truth for Work

タスクの canonical state は Linear に置く。ローカル state はあくまで orchestration のための補助 state とする。

ローカルに持つべきものは次に限定する。

- Slack thread と issue の対応
- follow-up の pending 状態
- planner の判断履歴
- dedupe と再試行のための操作履歴
- review / heartbeat の抑制情報

## Current Structure and Pain Points

現状の責務は大まかに以下に集約されている。

- [main.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/main.ts): Slack 入口、webhook 入口、thread queue、manager 呼び出し、fallback agent 呼び出し
- [manager.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/manager.ts): intake、progress、completed、blocked、research、review、follow-up を一括で処理
- [pi-session.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/pi-session.ts): runtime 作成、isolated turn 実行、planner prompt / parser / runner を併載
- [manager-state.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/manager-state.ts): policy と複数 ledger の schema / 永続化
- [linear-tools.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/linear-tools.ts): Linear 操作の custom tools

この構成でも動くが、execution manager として拡張するには次の問題がある。

- `manager.ts` が workflow ごとの境界を持たず肥大化しやすい
- `pi-session.ts` に runtime と planner の責務が混在している
- state が `intake`, `followups`, `planning` に分かれており、全体の work graph を直接表現していない
- テストの単位が「巨大な manager 関数」寄りで、workflow 単位の検証がしにくい
- 将来 `review`, `dependency`, `replanning`, `escalation` を足すと分岐がさらに崩れやすい

補足:

- repo には `skills/linear-cli/` と、それを workspace にコピーする処理がまだある
- これは現状の運用互換資産としては許容できる
- ただし execution manager の中長期設計では必須前提にしない

## Target Architecture

### Layered Design

将来像は以下の 6 層に分ける。

1. `app`
2. `adapters`
3. `orchestrators`
4. `planners`
5. `gateways`
6. `state`

責務は以下の通り。

- `app`: プロセス起動、DI、ルーティング、runtime 初期化
- `adapters`: Slack, scheduler, heartbeat, control room などの入出力
- `orchestrators`: workflow ごとのユースケース実行
- `planners`: LLM prompt / parser / runner / schema
- `gateways`: Linear, Slack context, web research など外部依存
- `state`: policy, repositories, event log, projections

### Proposed Directory Layout

```text
src/
  main.ts
  app/
    bootstrap.ts
    dependency-container.ts
    message-router.ts
  adapters/
    slack/
      slack-event-consumer.ts
      slack-reply-publisher.ts
      slack-attachment-store.ts
    scheduler/
      scheduler-runner.ts
    heartbeat/
      heartbeat-runner.ts
    control-room/
      control-room-publisher.ts
  domain/
    work/
      work-item.ts
      work-bundle.ts
      work-status.ts
      dependency.ts
    planning/
      plan-decision.ts
      planner-contracts.ts
    followup/
      followup-request.ts
      followup-resolution.ts
    review/
      risk-assessment.ts
      review-decision.ts
    policy/
      manager-policy.ts
      owner-routing.ts
  orchestrators/
    intake/
      handle-intake.ts
      build-work-creation-command.ts
      dedupe-intake.ts
    updates/
      handle-progress-update.ts
      handle-completed-update.ts
      handle-blocked-update.ts
    research/
      handle-research-child.ts
      synthesize-research-findings.ts
    followups/
      request-followup.ts
      resolve-followup-response.ts
    review/
      build-manager-review.ts
      build-heartbeat-review.ts
  planners/
    task-intake/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    followup-resolution/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    research-synthesis/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    review-assessment/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
  gateways/
    linear/
      linear-client.ts
      linear-commands.ts
      linear-queries.ts
      linear-tool-definitions.ts
    slack/
      slack-thread-context.ts
      slack-channel-context.ts
    web/
      web-search.ts
      web-fetch.ts
  runtime/
    agent-runtime-factory.ts
    isolated-turn-runner.ts
    thread-runtime-pool.ts
    system-prompt.ts
  state/
    repositories/
      policy-repository.ts
      owner-map-repository.ts
      followup-repository.ts
      planning-repository.ts
      workgraph-repository.ts
    projections/
      thread-context-projection.ts
      issue-focus-projection.ts
      review-suppression-projection.ts
    schemas/
      followup-ledger-schema.ts
      planning-ledger-schema.ts
      workgraph-event-schema.ts
  shared/
    clock.ts
    ids.ts
    json.ts
    text.ts
```

### Why This Layout Fits This Repo

この repo には次の特徴がある。

- Slack Socket Mode の常駐 botであり、必要に応じて Linear webhook 受信も同じ process で扱う
- `pi-coding-agent` を isolated turn と thread session の両方で使う
- Linear が task system of record である
- scheduler / heartbeat / control room も同じ process で持つ

したがって、一般的な web app の `controllers/services/repositories` よりも、`workflow` と `planner` を第一級のモジュールとして分ける構成の方が自然である。

## Responsibilities by Area

### `app`

`main.ts` を薄く保つための層。process boot と wiring だけを持つ。

- 設定ロード
- Slack / scheduler / heartbeat の起動
- thread queue と runtime pool の配線
- message kind に応じた orchestrator への routing

### `adapters`

外界との I/O を吸収する。

- Slack event を domain input に変換する
- Slack 返信を publish する
- 添付ファイル保存を行う
- scheduler と heartbeat から同じ orchestrator を呼ぶ

`main.ts` 直書きの Slack 処理は、ここに移す。

### `orchestrators`

execution manager の本体。workflow ごとに分ける。

- intake: request を issue creation plan に変換し Linear に反映
- updates: progress / completed / blocked を既存 issue に反映
- research: research issue から findings と next actions を生成
- followups: control room からの確認依頼とその回答解決
- review: 朝夕週次 review、heartbeat review

重要なのは、「LLM を呼ぶ場所」と「Linear を叩く場所」を orchestrator の中で明示的に分けること。

### `planners`

planner は 1 workflow 1 directory にする。

各 planner は次を持つ。

- `contract.ts`: zod schema と public type
- `prompt.ts`: prompt builder
- `parser.ts`: JSON extraction と parse
- `runner.ts`: isolated turn で LLM を呼ぶ関数
- `fixtures/`: 回帰テスト用の prompt / reply サンプル

これにより、planner の変更が manager 全体に波及しにくくなる。

### `gateways`

外部依存の集約点。agent custom tools の実体もここに寄せる。

- Linear query / command
- Slack thread context 取得
- web search / fetch

`linear-tools.ts` は将来的には `gateways/linear/linear-tool-definitions.ts` に移す。

### `state`

JSON ファイルの読み書きを直接呼ばせず、repository と projection で隠す。

短期的には file-backed repository で十分。長期的には SQLite に差し替えられるよう、interface を安定させる。

最低限必要な repository:

- `PolicyRepository`
- `OwnerMapRepository`
- `IntakeRepository`
- `FollowupRepository`
- `PlanningRepository`

将来的には `WorkgraphRepository` を追加し、複数 ledger の横断を projection ではなく単一イベント列として扱えるようにする。

## Workflow Contracts

execution manager の主要 workflow には、明示的な入出力型を持たせる。

### 1. Intake

入力:

- Slack request
- thread context
- pending clarification
- owner map
- duplicate candidates

出力:

- clarify
- link existing
- create single issue
- create parent + child issues

### 2. Progress / Completed / Blocked

入力:

- Slack update message
- thread-linked issues
- preferred issue candidates

出力:

- target issue decision
- state mutation command
- optional follow-up resolution update

### 3. Research

入力:

- research issue
- Slack thread summary
- recent channel summary
- related issues
- web evidence

出力:

- findings
- uncertainties
- next child tasks

### 4. Review

入力:

- risky issues
- follow-up cooldown state
- business-hours policy

出力:

- no-op
- control room summary
- explicit follow-up request

## State Model Recommendation

短期的には現行 ledger を活かしつつ repository 化する。中期的には event-sourced な work graph に寄せる。

### Short-Term

現行ファイルをそのまま repository の背後に置く。

- `policy.json`
- `owner-map.json`
- `followups.json`
- `planning-ledger.json`

この段階では file format を変えなくてよい。

### Mid-Term

`workgraph-events.jsonl` のような append-only event log を導入する。

例:

- `intake.received`
- `intake.clarification-requested`
- `linear.parent-created`
- `linear.child-created`
- `followup.requested`
- `followup.resolved`
- `issue.blocked`
- `issue.completed`

現在状態は projection で組み立てる。

## Migration Plan

### Phase 1: Planner Extraction

`pi-session.ts` から planner 群を分離する。

- `task-intake`
- `followup-resolution`
- `research-synthesis`

この段階では挙動を変えず、配置だけ整理する。

### Phase 2: Workflow Split

`manager.ts` を workflow ごとに分割する。

- intake
- updates
- followups
- review
- research

`handleManagerMessage` は router と orchestration entrypoint だけにする。

### Phase 3: Repository Layer

`manager-state.ts` の直接 read/write を repository に置き換える。

同時に、owner routing や dedupe などの横断ロジックを service 化する。

### Phase 4: Unified Work Graph

planning / intake / followup を単一の work graph として再構成する。

ここまで進むと、thread ベースではなく issue / follow-up / dependency ベースで review が組める。

## File Mapping From Current Code

現行ファイルからの移し先は概ね次の通り。

- [main.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/main.ts) -> `app/`, `adapters/`
- [manager.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/manager.ts) -> `orchestrators/`, `domain/`, `services`
- [pi-session.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/pi-session.ts) -> `runtime/`, `planners/`
- [manager-state.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/manager-state.ts) -> `state/`
- [linear-tools.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/linear-tools.ts) -> `gateways/linear/`
- [slack-context.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/slack-context.ts) -> `gateways/slack/`
- [web-research.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/cogito-work-manager/src/lib/web-research.ts) -> `gateways/web/`

## Decision Summary

この repo の execution manager 設計として採るべき方針は以下。

- 会話中心ではなく orchestration 中心にする
- LLM は planner / assessor として限定利用する
- 型付き contract を planner の境界に置く
- 外部副作用は command 化して idempotent に扱う
- local state は orchestration の補助に限定する
- workflow ごとに module を分割する
- skill は不要とし、設計の中心に置かない

この方針なら、今後 `dependency management`, `replanning`, `multi-step approval`, `SLA based follow-up`, `owner escalation` を追加しても崩れにくい。
