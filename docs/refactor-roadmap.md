# Refactor Roadmap

この文書は [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/execution-manager-architecture.md) の補足ではなく、実装順序、完了条件、禁止事項を固定するための運用文書である。

対象読者は maintainers / implementers とする。user-facing な挙動説明文書ではない。

この roadmap は中期の Phase 1-4 完了までを対象にする。runtime API や user-facing interface の変更は目的に含めない。

## Global Rules

- LLM は planner / assessor に限定して使う
- 外部副作用は必ず code-side command を経由して実行する
- Linear を work の source of truth とする
- legacy ファイルへ新機能を積み増さない
- 1 つの PR で phase をまたがない
- Phase N の完了条件を満たすまで、Phase N+1 の本実装に入らない
- 互換 export が必要な間は維持し、移行完了後にまとめて整理する

## Phase Overview

| Phase | Name | Primary Goal | Depends On | Entry Condition | Completion Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | Planner Extraction | planner を `src/planners/` へ分離する | none | architecture doc と AGENTS の方針が確定している | planner 群が `pi-session.ts` から論理分離され、挙動互換が保たれている |
| 2 | Workflow Split | workflow を `orchestrators/` 単位へ分離する | Phase 1 | planner 呼び出し境界が安定している | `manager.ts` が router 寄りになり、主要 workflow が独立モジュール化されている |
| 3 | Repository Layer | file-backed repository を導入する | Phase 2 | workflow 境界が明確で state access 箇所が把握できている | `manager-state.ts` 直 read/write 依存が repository 経由に置き換わっている |
| 4 | Unified Work Graph | planning / intake / followup を横断する work graph を導入する | Phase 3 | repository 層が安定し、既存 ledger の責務が整理されている | append-only event log と projection を用いた work graph が導入されている |

## PR Rules

- 1 phase を複数 PR に分けてよい
- ただし 1 PR は 1 phase に閉じる
- phase 内でも挙動変更と構造変更は可能な限り分ける
- 移行途中は既存 call site と export を壊さず、差し替え可能な単位で進める
- docs のみで設計判断が変わる場合は、必要に応じて architecture doc と AGENTS を同時更新する

## Phase 1: Planner Extraction

### Goal

`src/lib/pi-session.ts` から planner 群を `src/planners/` に分離し、runtime 構築責務と planner 責務を切り分ける。

### In Scope

- `task-intake`
- `followup-resolution`
- `research-synthesis`
- 各 planner の `contract.ts`, `prompt.ts`, `parser.ts`, `runner.ts`, `fixtures/`
- 既存テストの移設または補強
- 既存 call site の import 差し替え

### Out of Scope

- planner の挙動変更
- schema shape の変更
- `review-assessment` の新設
- workflow 分割
- repository 導入

### Implementation Shape

- `src/planners/task-intake/` を作り、`TaskPlanningInput`, `TaskPlanningResult`, prompt builder, parser, runner を移す
- 同じ形式で `followup-resolution` と `research-synthesis` を分離する
- `pi-session.ts` には runtime factory と isolated turn runner の責務を残し、planner 実装は持たせない
- 既存の public API が必要なら `pi-session.ts` から再 export してよいが、実体は `src/planners/` に置く
- planner fixture は prompt / reply の回帰確認に使える形で保持する

### Validation

- 既存 planner 関連テストが通る
- prompt / parser / runner の分離後も import 先以外の挙動が変わらない
- `pi-session.ts` に planner 実装詳細が残っていない

### Done

- `task-intake`, `followup-resolution`, `research-synthesis` が `src/planners/` 配下に存在する
- `pi-session.ts` が runtime 中心のファイルになっている
- planner 系のテストが分離後の配置を前提に維持されている

## Phase 2: Workflow Split

### Goal

`src/lib/manager.ts` を workflow ごとの orchestrator に分割し、`handleManagerMessage` を router 寄りの entrypoint に縮小する。

### In Scope

- `intake`
- `updates`
- `research`
- `followups`
- `review`
- workflow ごとのユースケース分離
- `handleManagerMessage` の router 化

### Out of Scope

- work graph 導入
- state storage format の変更
- planner contract の再設計
- Linear gateway の全面再編

### Implementation Shape

- `src/orchestrators/intake/`, `updates/`, `research/`, `followups/`, `review/` を作る
- request / progress / completed / blocked / review 系の入口を段階的に移す
- `handleManagerMessage` は message kind 判定と orchestrator 呼び出しに寄せる
- 新しい workflow は legacy 集約ファイルに追加しない
- LLM 呼び出し位置と Linear command 実行位置を orchestrator の中で明示的に分ける

### Validation

- `manager.ts` の責務が router と互換 facade に縮小している
- workflow 単位テストで既存挙動を維持できている
- 新規ロジックが `manager.ts` に直接追加されていない

### Done

- 主要 workflow が `src/orchestrators/` に分離されている
- `handleManagerMessage` が workflow 直接実装ではなく dispatch 中心になっている
- workflow 単位のテスト構成が成立している

## Phase 3: Repository Layer

### Goal

`src/lib/manager-state.ts` の直接 read/write を file-backed repository に置き換え、state access の境界を固定する。

### In Scope

- `PolicyRepository`
- `OwnerMapRepository`
- `IntakeRepository`
- `FollowupRepository`
- `PlanningRepository`
- repository interface と file-backed implementation

### Out of Scope

- SQLite への移行
- storage file format の変更
- work graph の本導入
- projection の全面導入

### Implementation Shape

- `src/state/repositories/` を追加し、現行 JSON file を背後に持つ repository を実装する
- `manager-state.ts` は schema と互換ヘルパーに縮小するか、repository 内部へ段階移行する
- workflow からの state access は repository 経由に寄せる
- 既存の `policy.json`, `owner-map.json`, `intake-ledger.json`, `followups.json`, `planning-ledger.json` は format を維持する

### Validation

- 主要 workflow が JSON file を直接 read/write しない
- repository 導入後も storage format が変わっていない
- state access の単体テストが repository 単位で書ける

### Done

- policy / owner-map / intake / followup / planning の repository が存在する
- workflow 側は repository 経由で state を扱っている
- `manager-state.ts` への直接依存が大幅に減っている

## Phase 4: Unified Work Graph

### Goal

planning / intake / followup を横断する work graph を導入し、append-only event log と projection を前提に orchestration state を統合する。

### In Scope

- `WorkgraphRepository`
- append-only event log
- projection ベースの現在状態復元
- planning / intake / followup の横断状態モデル
- 既存 ledger との移行レイヤ

### Out of Scope

- 全 workflow の一括再設計
- 外部 system of record の追加
- Linear を置き換える独自 state machine

### Implementation Shape

- `workgraph-events.jsonl` 相当の append-only event log を導入する
- `intake.received`, `intake.clarification-requested`, `linear.parent-created`, `linear.child-created`, `followup.requested`, `followup.resolved`, `issue.blocked`, `issue.completed` などのイベントを定義する
- 現在状態は projection で再構成する
- 既存 ledger は移行期間中の互換レイヤとして扱い、急に削除しない

### Current Boundary

- Linear は引き続き work 自体の source of truth とする
- work graph は cross-workflow read model の優先経路として扱う
- 現在の read-side では、review 件数集計、issue source lookup、thread planning context、latest resolved issue、updates の target-resolution candidate discovery を work graph query から取得する
- legacy ledger は互換レイヤとして残し、pending clarification の照合、issue focus history、未移行 helper の補助情報を保持する
- source of truth の切り替えは dual-write と query migration を段階的に進め、ledger の削除は最後に行う

### Validation

- intake / planning / followup の横断状態が単一モデルで再構成できる
- append-only event log から必要な現在状態を再計算できる
- 移行期間中も既存 workflow が破綻しない

### Done

- work graph のイベント定義、repository、projection が存在する
- 既存 ledger と work graph の責務分担が明文化されている
- intake / planning / followup の主要判断が unified state を前提に扱える

## Validation Checklist

- Phase 番号と名称が architecture doc と一致している
- 各 phase の `In Scope` と `Out of Scope` が矛盾していない
- legacy 互換方針が [AGENTS.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/AGENTS.md) のルールと衝突していない
- この roadmap が architecture doc の詳細化であり、別アーキテクチャを定義していない

## Defaults and Assumptions

- roadmap の対象は直近だけではなく、中期の Phase 1-4 完了までを含む
- 各 phase は phase-gated で進める
- 先に構造を分け、その後に state 統合へ進む
- docs-only の更新であり、この文書自体はコード変更を直接伴わない
