// 只读领域目录：加载 fixtures，并提供报价/条款时点选择、正式计划定位、
// 每期利率形成解释、入账金额全链路追溯。所有函数不修改数据。
import { readFile } from "node:fs/promises";

const FX = new URL("../fixtures/", import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, FX), "utf8"));

export async function loadContext() {
  return readJson("context.json");
}

export async function loadDataset() {
  const [quotesFile, contractsFile, eventsFile, schedulesFile, entriesFile, deliveriesFile] =
    await Promise.all([
      readJson("lpr-quotes.json"),
      readJson("loan-contracts.json"),
      readJson("change-events.json"),
      readJson("repayment-schedules.json"),
      readJson("interest-entries.json"),
      readJson("inbound-deliveries.json"),
    ]);
  return {
    quotes: quotesFile.quotes,
    contracts: contractsFile.contracts,
    events: eventsFile.events,
    schedules: schedulesFile.schedules,
    entries: entriesFile.entries,
    deliveries: deliveriesFile.deliveries,
  };
}

export const dayOf = (t) => String(t).slice(0, 10);

// 在取价日 date 引用某品种“当时有效”的报价版本。
// asOfTs 用于复现历史视角：晚于该时点发布的版本（含尚未发布的勘误）不可见。
// 同一区间存在多条版本（勘误）时取最高版本——勘误由发布机构授权，回溯覆盖原值。
export function effectiveQuoteAt(quotes, tenor, date, asOfTs = null) {
  return (
    quotes
      .filter(
        (q) =>
          q.tenor === tenor &&
          (asOfTs === null || q.publish_date <= asOfTs) &&
          dayOf(q.effective_from) <= date &&
          (q.effective_to === null || date < dayOf(q.effective_to)),
      )
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

// 合同条款的时点版本（区间左闭右开）。
export function termsAt(contract, date) {
  return (
    contract.terms_versions.find(
      (v) => v.effective_from <= date && (v.effective_to === null || date < v.effective_to),
    ) ?? null
  );
}

export const getContract = (ds, contractId) =>
  ds.contracts.find((c) => c.contract_id === contractId) ?? null;

// 某合同在指定日历日的“管辖版本”（按利率适用区间 official_from）；不传日期取当前正式计划。
// 用于客户视角：哪一版计划管辖该日历日的计息。周末顺延时新版本会回溯到名义重定价日。
// 不变量：同一合同任一日历日至多一条管辖版本。
export function officialSchedule(ds, contractId, date = null) {
  const live = ds.schedules.filter(
    (s) => s.contract_id === contractId && s.status === "official",
  );
  if (live.length > 1) {
    throw new Error(`合同 ${contractId} 存在 ${live.length} 条 official 计划，违反单一正式计划不变量`);
  }
  if (date === null) return live[0] ?? null;
  return (
    ds.schedules
      .filter(
        (s) =>
          s.contract_id === contractId &&
          s.status !== "abandoned" &&
          s.official_from !== null &&
          s.official_from <= date,
      )
      .sort((a, b) => (a.official_from < b.official_from ? 1 : -1))[0] ?? null
  );
}

// 审计视角：在某个系统时刻 timestamp，核心系统实际持有的正式计划。
// 周末顺延造成的“结算时滞”期间，旧版本仍是权威版本，直到新版本创建时刻被替代。
// 不变量：同一合同任一时刻至多一条权威正式计划。
export function officialScheduleAsAt(ds, contractId, timestamp) {
  const candidates = ds.schedules.filter(
    (s) =>
      s.contract_id === contractId &&
      s.status !== "abandoned" &&
      s.created_at <= timestamp &&
      (s.superseded_at === null || timestamp < s.superseded_at),
  );
  if (candidates.length > 1) {
    throw new Error(
      `合同 ${contractId} 在 ${timestamp} 存在 ${candidates.length} 条权威正式计划`,
    );
  }
  return candidates[0] ?? null;
}

export const installmentOf = (schedule, periodNo) =>
  schedule.installments.find((i) => i.period_no === periodNo) ?? null;

// 客户视角：一期利率如何形成。
// 默认解释当前正式计划；给定 scheduleId 时解释指定历史版本（审计视角）。
export function explainPeriod(ds, contractId, periodNo, scheduleId = null) {
  const contract = getContract(ds, contractId);
  if (!contract) throw new Error(`合同不存在：${contractId}`);
  const schedule = scheduleId
    ? ds.schedules.find((s) => s.schedule_id === scheduleId)
    : officialSchedule(ds, contractId);
  if (!schedule) throw new Error(`找不到计划：${scheduleId ?? `${contractId} 的正式计划`}`);
  const inst = installmentOf(schedule, periodNo);
  if (!inst) throw new Error(`计划 ${schedule.schedule_id} 不存在第 ${periodNo} 期`);

  const snap = inst.rate_snapshot;
  const quote = snap.quote_id ? ds.quotes.find((q) => q.quote_id === snap.quote_id) : null;
  const terms = termsAt(contract, snap.repricing_date_adjusted);
  const scheduleEvent = schedule.change_event_id
    ? ds.events.find((e) => e.event_id === schedule.change_event_id)
    : null;

  return {
    contract_id: contractId,
    schedule_id: schedule.schedule_id,
    schedule_status: schedule.status,
    period_no: periodNo,
    accrual_period: {
      start: inst.period_start,
      end: inst.period_end,
      half_open: "[start, end)",
    },
    due: { due_date: inst.due_date, adjusted_due_date: inst.adjusted_due_date },
    repricing: {
      nominal_date: snap.repricing_date,
      effective_take_date: snap.repricing_date_adjusted,
      adjusted: snap.repricing_date !== snap.repricing_date_adjusted,
    },
    rate:
      snap.effective_rate_bps === null
        ? null
        : {
            quote_rate_bps: snap.quote_rate_bps,
            spread_bps: snap.spread_bps,
            effective_rate_bps: snap.effective_rate_bps,
            formula_check: snap.quote_rate_bps + snap.spread_bps === snap.effective_rate_bps,
          },
    quote: quote
      ? {
          quote_id: quote.quote_id,
          tenor: quote.tenor,
          version: quote.version,
          rate_bps: quote.rate_bps,
          publish_date: quote.publish_date,
          effective_from: quote.effective_from,
          effective_to: quote.effective_to,
          status: quote.status,
          source: quote.source,
          supersedes_quote_id: quote.supersedes_quote_id,
          erratum_note: quote.erratum_note,
        }
      : null,
    terms_version: terms
      ? {
          version: terms.version,
          benchmark_tenor: terms.benchmark_tenor,
          spread_bps: terms.spread_bps,
          repricing_frequency_months: terms.repricing_frequency_months,
          repricing_day_rule: terms.repricing_day_rule,
          holiday_rule: terms.holiday_rule,
          effective_from: terms.effective_from,
          effective_to: terms.effective_to,
          approval_ref: terms.approval_ref,
          approved_by: terms.approved_by,
        }
      : null,
    produced_by: scheduleEvent
      ? {
          event_id: scheduleEvent.event_id,
          type: scheduleEvent.type,
          origin: scheduleEvent.origin,
          approved_by: scheduleEvent.approved_by,
          approval_ref: scheduleEvent.approval_ref,
          occurred_at: scheduleEvent.occurred_at,
        }
      : { note: "放款生成的首版计划，无变更事件" },
    narrative: snap.formula,
    amounts: {
      balance_before_cents: inst.balance_before_cents,
      interest_cents: inst.interest_cents,
      principal_cents: inst.principal_cents,
    },
  };
}

// 审计视角：从任一入账金额逐级追溯到计息期、LPR报价版本、合同条款版本与批准变更。
// 红冲/蓝补与其原始入账互相串联；任何一环缺失都会在结果中标注 broken=true。
export function traceEntry(ds, entryId) {
  const entry = ds.entries.find((x) => x.entry_id === entryId);
  if (!entry) throw new Error(`入账不存在：${entryId}`);

  const broken = [];
  const schedule = ds.schedules.find((s) => s.schedule_id === entry.schedule_id);
  if (!schedule) broken.push(`计划缺失：${entry.schedule_id}`);
  const inst = schedule ? installmentOf(schedule, entry.period_no) : null;
  if (schedule && !inst) broken.push(`计划 ${schedule.schedule_id} 缺第 ${entry.period_no} 期`);

  const quote = entry.rate_quote_id
    ? ds.quotes.find((q) => q.quote_id === entry.rate_quote_id)
    : null;
  if (entry.rate_quote_id && !quote) broken.push(`报价缺失：${entry.rate_quote_id}`);

  const contract = getContract(ds, entry.contract_id);
  const terms = contract
    ? contract.terms_versions.find((v) => v.version === entry.terms_version)
    : null;
  if (!contract) broken.push(`合同缺失：${entry.contract_id}`);
  if (contract && !terms) broken.push(`条款版本缺失：v${entry.terms_version}`);

  const changeEvent = entry.change_event_id
    ? ds.events.find((e) => e.event_id === entry.change_event_id)
    : null;
  if (entry.change_event_id && !changeEvent) broken.push(`变更事件缺失：${entry.change_event_id}`);

  const relatesTo = [];
  if (entry.reversal_of) {
    const target = ds.entries.find((x) => x.entry_id === entry.reversal_of);
    if (!target) broken.push(`被红冲原入账缺失：${entry.reversal_of}`);
    relatesTo.push({ relation: "reversal_of", entry: summarizeEntry(target) });
  }
  if (entry.correction_of) {
    const target = ds.entries.find((x) => x.entry_id === entry.correction_of);
    if (!target) broken.push(`被更正原入账缺失：${entry.correction_of}`);
    relatesTo.push({ relation: "correction_of", entry: summarizeEntry(target) });
  }
  for (const other of ds.entries) {
    if (other.reversal_of === entry.entry_id)
      relatesTo.push({ relation: "reversed_by", entry: summarizeEntry(other) });
    if (other.correction_of === entry.entry_id)
      relatesTo.push({ relation: "corrected_by", entry: summarizeEntry(other) });
  }

  return {
    broken: broken.length > 0,
    gaps: broken,
    entry: summarizeEntry(entry, true),
    period: inst
      ? {
          schedule_id: schedule.schedule_id,
          schedule_status: schedule.status,
          period_no: inst.period_no,
          period_start: inst.period_start,
          period_end: inst.period_end,
          snapshot: inst.rate_snapshot,
        }
      : null,
    quote: quote
      ? {
          quote_id: quote.quote_id,
          tenor: quote.tenor,
          version: quote.version,
          rate_bps: quote.rate_bps,
          publish_date: quote.publish_date,
          effective_window: { from: quote.effective_from, to: quote.effective_to },
          status: quote.status,
          source: quote.source,
          supersedes_quote_id: quote.supersedes_quote_id,
          erratum_note: quote.erratum_note,
        }
      : null,
    contract_terms: terms
      ? {
          contract_id: entry.contract_id,
          version: terms.version,
          benchmark_tenor: terms.benchmark_tenor,
          spread_bps: terms.spread_bps,
          repricing_frequency_months: terms.repricing_frequency_months,
          repricing_day_rule: terms.repricing_day_rule,
          holiday_rule: terms.holiday_rule,
          approved_by: terms.approved_by,
          approval_ref: terms.approval_ref,
          effective_from: terms.effective_from,
          effective_to: terms.effective_to,
        }
      : null,
    approved_change: changeEvent
      ? {
          event_id: changeEvent.event_id,
          type: changeEvent.type,
          origin: changeEvent.origin,
          effective_date: changeEvent.effective_date,
          approved_by: changeEvent.approved_by,
          approval_ref: changeEvent.approval_ref,
          detail: changeEvent.detail,
        }
      : null,
    related_entries: relatesTo,
  };
}

function summarizeEntry(e, full = false) {
  if (!e) return null;
  const base = {
    entry_id: e.entry_id,
    kind: e.kind,
    amount_cents: e.amount_cents,
    status: e.status,
    value_date: e.value_date,
    schedule_id: e.schedule_id,
    period_no: e.period_no,
  };
  return full
    ? {
        ...base,
        contract_id: e.contract_id,
        posted_at: e.posted_at,
        idempotency_key: e.idempotency_key,
        rate_quote_id: e.rate_quote_id,
        terms_version: e.terms_version,
        reversal_of: e.reversal_of,
        correction_of: e.correction_of,
        change_event_id: e.change_event_id,
      }
    : base;
}

// 幂等体检：返回各类集合中重复出现的幂等键（重复即可能造成重复入账/重复版本）。
export function duplicateIdempotencyKeys(ds) {
  const scan = (rows, key = "idempotency_key") => {
    const seen = new Map();
    const dup = new Set();
    for (const r of rows) {
      const k = r[key];
      if (seen.has(k)) dup.add(k);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...dup];
  };
  return {
    entries: scan(ds.entries),
    events: scan(ds.events),
    schedules: scan(ds.schedules),
    deliveries: scan(ds.deliveries, "message_id"),
  };
}
