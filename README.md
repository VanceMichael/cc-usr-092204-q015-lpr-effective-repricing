# LPR 生效重定价

本项目服务于维护 LPR 发布、生效区间与贷款合同重定价。仓库保存领域资料、交换契约、
去标识样例数据和可运行的只读服务，使“发布日期 / 实际生效窗口 / 合同加点”不再被混为一谈，
并让客户、财务与审计都能从任一期利率或任一入账金额追到当时有效的报价、条款与批准变更。

## 领域事实（不可违背的不变量）

- **期限品种分别发布**：一年期（1Y）与五年期以上（5Y+）LPR 由央行授权全国银行间同业拆借中心
  分别公布；一次发布可能只调一个品种。每条报价保存授权来源（发布机构、渠道、公告编号）。
- **三个时间概念严格分开**：报价 `publish_date`（发布时刻）、报价有效窗口
  `[effective_from, effective_to)`、合同 `repricing_date`（重定价日）互不相同。
- **勘误留痕**：勘误以新版本登记、回溯覆盖原区间并链接原报价；原版本置 `corrected` 但保留，
  其历史被引用记录由利率快照固定，不被静默改写。勘误发布前的取价视角取不到勘误值。
- **合同条款版本化**：基准期限品种、加减点（可为负）、重定价频率、重定价日规则、节假日规则
  均按版本保存，变更经批准后按生效日适用。
- **执行利率 = 重定价日有效 LPR 快照 + 合同加减点**；新报价只影响满足合同条件的未来计息区间。
  每期保存完整利率快照（报价 ID、品种、数值、发布日、来源、条款版本、公式叙述）。
- **节假日顺延**：名义重定价日落周末时顺延至下一工作日取价，但计息区间仍自名义日开始，
  引用报价与加点不变；`repricing_date` 与 `repricing_date_adjusted` 同时留痕。
- **一个合同只有一条正式计划**：计划版本状态为 `draft / official / superseded / abandoned`。
  批量重定价与客户临时变更并发时，以合同为粒度串行化，落败草稿置 `abandoned` 且从未正式。
- **已入账利息不得静默重算**：历史更正以红冲（`reversal`，负额）+ 蓝补（`correction`）
  成对登记，原入账置 `reversed` 但不删除、不覆盖。
- **幂等**：报价/变更消息与入账请求均带幂等键；重复投递登记为 `duplicate_skipped`，
  不产生第二版计划或第二笔入账。可重试失败不影响最终恰好一次的业务效果。
- **全链路可追溯**：任一入账金额 → 计息期与计划版本 → LPR 报价版本（含授权来源）→
  当时有效的合同条款版本 → 批准变更事件。

### 两条时间轴

同一份计划版本在两条时间轴上定位，周末顺延时两者相差一个周末：

- **利率适用轴**（日历日）：`official_from` 起该版本管辖计息，新版本回溯到名义重定价日。
- **系统权威轴**（时刻）：`[created_at, superseded_at)` 内该版本是核心系统实际持有并据以
  入账的唯一权威计划。顺延的工作日新版本创建前，旧版本仍是权威。

## 目录说明

- `contracts/` — 交换契约（JSON Schema, draft 2020-12）：
  - `lpr-quote.schema.json` 报价版本与勘误
  - `loan-contract.schema.json` 合同与条款版本
  - `change-event.schema.json` 条款变更 / 提前还款 / 勘误更正等批准事件
  - `repayment-schedule.schema.json` 还款计划版本与每期利率快照
  - `interest-entry.schema.json` 利息入账、红冲、蓝补
  - `inbound-delivery.schema.json` 入站消息投递与幂等台账
- `fixtures/` — 去标识样例（由生成脚本确定性产出，金额可独立复算）：
  - 合同 A：5Y+、按放款周年日重定价，含 2025 年加点转换的**批量/客户并发**（一版胜出、
    一版废弃）与 2026 年提前还款；
  - 合同 B：1Y、按季重定价，含 2024-12 报价**勘误**、已入账期的红冲蓝补、未来期重算，
    以及多个周末顺延重定价日。
- `scripts/build-fixtures.mjs` — 样例生成器（ACT/365、等额本息、按期快照）。
- `src/catalog.js` — 只读目录与纯函数：时点报价、时点条款、正式计划定位、
  每期利率解释 `explainPeriod`、金额追溯 `traceEntry`。
- `src/server.js` — 只读 HTTP 服务。
- `test/` — Schema 校验、领域不变量（独立复算金额/余额/冲正）与 HTTP 端点测试。

## 只读服务

```bash
npm start            # http://127.0.0.1:8000
```

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /context` | 领域角色、事实、术语 |
| `GET /contracts` | 合同清单与当前正式计划 ID |
| `GET /quotes?tenor=1Y&date=2024-12-20[&asAt=...]` | 某日当时有效报价；`asAt` 复现历史视角（勘误前/后） |
| `GET /contracts/{id}/schedule` | 当前正式计划 |
| `GET /contracts/{id}/schedule?date=YYYY-MM-DD` | 利率适用轴上某日管辖版本 |
| `GET /contracts/{id}/schedule?asAt=YYYY-MM-DDTHH:mm:ss+08:00` | 系统权威轴上某时刻持有版本 |
| `GET /contracts/{id}/periods/{n}/explain[?scheduleId=...]` | 客户视角：每期利率如何形成 |
| `GET /entries/{entryId}/trace` | 审计视角：金额 → 期 → 报价 → 条款 → 批准变更 |

服务仅读取已发布资料，不产生任何业务效果。

## 本地检查

```bash
npm install                 # 安装 ajv / ajv-formats（测试期 Schema 校验）
npm run generate-fixtures   # 重新确定性生成 fixtures/
npm test                    # Schema + 44 项领域不变量/复算 + HTTP 端点
```

测试不引用生成器逻辑，而是用独立的日历与 ACT/365 计息代码复算每期利息、本金结转、
提前还款余额跳减、末期归零与红冲蓝补净额，避免“用实现验证实现”。
