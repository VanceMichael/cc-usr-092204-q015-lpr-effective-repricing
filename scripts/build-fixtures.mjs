// 生成 fixtures/ 下全部去标识样例数据。
// 运行：node scripts/build-fixtures.mjs
// 计息约定：ACT/365；等额本息在每个利率段起点按剩余本金/剩余期数重算月供；
// 每期利息 = 期初余额 * 年利率 * 区间实际天数/365，末期轧差本金。
// 重定价日为合同名义日；遇周末按 following_adjusted 顺延取价，利率仍自名义日起适用。
// 工作日顺延仅处理周六/周日（样例不枚举法定节假日）；时间戳均带 +08:00。
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FX = join(ROOT, "fixtures");

// ---------- 日期工具（UTC 日历日，区间左闭右开） ----------
const DAY = 86_400_000;
const d = (s) => new Date(s + "T00:00:00Z");
const iso = (dt) => dt.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(d(s).getTime() + n * DAY));
const addMonths = (s, n) => {
  const dt = d(s);
  return iso(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, dt.getUTCDate())));
};
const daysBetween = (a, b) => Math.round((d(b) - d(a)) / DAY);
const weekday = (s) => d(s).getUTCDay(); // 0=Sun 6=Sat
const following = (s) => (weekday(s) === 6 ? addDays(s, 2) : weekday(s) === 0 ? addDays(s, 1) : s);
const ts = (date, hm = "09:15:00") => `${date}T${hm}+08:00`;
const roundCny = (x) => Math.round(x);
const monthsBetween = (a, b) =>
  (d(b).getUTCFullYear() - d(a).getUTCFullYear()) * 12 +
  (d(b).getUTCMonth() - d(a).getUTCMonth());

// ---------- LPR 报价序列 ----------
// [名义发布月, 报价bp, 实际发布日(默认20日顺延后的工作日)]
const SERIES_1Y = [
  ["2024-06", 345], ["2024-07", 335, "2024-07-22"], ["2024-08", 335],
  ["2024-09", 330], ["2024-10", 325, "2024-10-21"], ["2024-11", 325],
  ["2024-12", 310], // 发布后两个交易日勘误为 315
  ["2025-01", 310, "2025-01-20"], ["2025-02", 310], ["2025-03", 305],
  ["2025-04", 305, "2025-04-21"], ["2025-05", 300], ["2025-06", 300],
  ["2025-07", 300, "2025-07-21"], ["2025-08", 295], ["2025-09", 295, "2025-09-22"],
  ["2025-10", 290], ["2025-11", 290], ["2025-12", 285, "2025-12-22"],
  ["2026-01", 285], ["2026-02", 280], ["2026-03", 280],
  ["2026-04", 285], ["2026-05", 290], ["2026-06", 290, "2026-06-22"],
  ["2026-07", 295], ["2026-08", 300], ["2026-09", 300, "2026-09-21"],
];
const SERIES_5Y = [
  ["2023-06", 420], ["2023-08", 400, "2023-08-21"],
  ["2024-02", 395], ["2024-07", 385, "2024-07-22"],
  ["2024-10", 360, "2024-10-21"], ["2025-05", 370],
  ["2025-10", 365], ["2026-05", 380],
];

const SOURCE = (ref) => ({
  publisher: "全国银行间同业拆借中心",
  channel: "中国货币网官方公告",
  notice_ref: ref,
});

function buildQuotes() {
  const quotes = [];
  const makeSeries = (tenor, series, refPrefix) => {
    const rows = series.map(([month, rate, pub]) => ({
      month,
      rate,
      publishDate: pub ?? following(`${month}-20`),
    }));
    rows.forEach((row, i) => {
      const next = rows[i + 1];
      const erratum = tenor === "1Y" && row.month === "2024-12";
      const qid = `Q-${tenor}-${row.month}`;
      quotes.push({
        quote_id: qid,
        source: SOURCE(`${refPrefix}${row.month.replace("-", "")}`),
        tenor,
        version: 1,
        supersedes_quote_id: null,
        rate_bps: row.rate,
        publish_date: ts(row.publishDate),
        effective_from: ts(row.publishDate),
        effective_to: next ? ts(next.publishDate) : null,
        status: erratum ? "corrected" : next ? "expired" : "active",
        erratum_note: erratum ? "首发数值录入有误，已由勘误版本替代，见同批次v2" : null,
      });
      if (erratum) {
        // 勘误于两个交易日后发布，区间回溯覆盖原报价；原版本自勘误发布时点起不再可供取价。
        const errDate = "2024-12-23";
        quotes.push({
          quote_id: `Q-${tenor}-${row.month}-ERR`,
          source: SOURCE(`${refPrefix}${row.month.replace("-", "")}-E`),
          tenor,
          version: 2,
          supersedes_quote_id: qid,
          rate_bps: 315,
          publish_date: ts(errDate, "09:30:00"),
          effective_from: ts(row.publishDate),
          effective_to: next ? ts(next.publishDate) : null,
          status: next ? "expired" : "active",
          erratum_note: "勘误：一年期LPR应为3.15%，原公告3.10%有误，特此更正",
        });
        const original = quotes.find((q) => q.quote_id === qid);
        original.effective_to = ts(errDate, "09:30:00");
      }
    });
  };
  makeSeries("1Y", SERIES_1Y, "SHIBOR-LPR-A-");
  makeSeries("5Y+", SERIES_5Y, "SHIBOR-LPR-B-");
  return quotes;
}

// ---------- 合同 ----------
function buildContracts() {
  return [
    {
      contract_id: "LN-A-2023-0001",
      product: "个人经营性抵押贷款（浮动利率）",
      currency: "CNY",
      principal_cents: 100_000_000,
      start_date: "2023-09-25",
      maturity_date: "2028-09-25",
      day_count: "ACT/365",
      repayment_method: "equal_installment",
      payment_frequency_months: 1,
      terms_versions: [
        {
          version: 1,
          effective_from: "2023-09-25",
          effective_to: "2025-09-25",
          benchmark_tenor: "5Y+",
          spread_bps: 50,
          repricing_frequency_months: 12,
          repricing_day_rule: "loan_anniversary",
          day_of_month: null,
          holiday_rule: "following_adjusted",
          application: "on_repricing_date",
          change_event_id: null,
          approved_by: "放款审批岗 ZHANG/W0812",
          approval_ref: "APV-DISB-20230925-118",
        },
        {
          version: 2,
          effective_from: "2025-09-25",
          effective_to: null,
          benchmark_tenor: "5Y+",
          spread_bps: -10,
          repricing_frequency_months: 12,
          repricing_day_rule: "loan_anniversary",
          day_of_month: null,
          holiday_rule: "following_adjusted",
          application: "on_repricing_date",
          change_event_id: "E-A-TERMS-2025",
          approved_by: "零售信贷审批岗 LI/M2230",
          approval_ref: "APV-CONV-20250924-007",
        },
      ],
    },
    {
      contract_id: "LN-B-2024-0002",
      product: "小微企业流动资金贷款（浮动利率）",
      currency: "CNY",
      principal_cents: 50_000_000,
      start_date: "2024-06-20",
      maturity_date: "2027-06-20",
      day_count: "ACT/365",
      repayment_method: "equal_installment",
      payment_frequency_months: 1,
      terms_versions: [
        {
          version: 1,
          effective_from: "2024-06-20",
          effective_to: null,
          benchmark_tenor: "1Y",
          spread_bps: -30,
          repricing_frequency_months: 3,
          repricing_day_rule: "month_day",
          day_of_month: 20,
          holiday_rule: "following_adjusted",
          application: "on_repricing_date",
          change_event_id: null,
          approved_by: "放款审批岗 CHEN/H4471",
          approval_ref: "APV-DISB-20240620-352",
        },
      ],
    },
  ];
}

// ---------- 报价与条款的时点选择 ----------
// 在取价日 date 引用某品种报价；asOfTs 为可见性时点（晚于它发布的版本，含未发布勘误，不可见）。
function effectiveQuoteAt(quotes, tenor, date, asOfTs = null) {
  const visible = (q) => asOfTs === null || q.publish_date <= asOfTs;
  return (
    quotes
      .filter(
        (q) =>
          q.tenor === tenor &&
          visible(q) &&
          q.effective_from.slice(0, 10) <= date &&
          (q.effective_to === null || date < q.effective_to.slice(0, 10)),
      )
      // 同一区间存在勘误版本时，勘误（高版本）在其发布后对取价可见
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

const termsAt = (contract, date) =>
  contract.terms_versions.find(
    (v) => v.effective_from <= date && (v.effective_to === null || date < v.effective_to),
  );

// ---------- 分期计划生成 ----------
function formulaText({ p, seg, tv, tenor }) {
  if (seg.quote_id === null) {
    return `第${p}期利率待重定价日${seg.repricing_date_adjusted}取价确定；合同基准${tenor} LPR ${tv.spread_bps >= 0 ? "+" : ""}${tv.spread_bps}bp`;
  }
  return (
    `执行利率${((seg.quote_rate_bps + tv.spread_bps) / 100).toFixed(2)}% = ` +
    `${seg.repricing_date_adjusted}取价有效${tenor} LPR ${(seg.quote_rate_bps / 100).toFixed(2)}%` +
    `（报价${seg.quote_id}，${seg.repricing_date_adjusted === seg.repricing_date ? "重定价日未顺延" : `名义重定价日${seg.repricing_date}遇周末顺延`}）` +
    `${tv.spread_bps >= 0 ? "+" : ""}${(tv.spread_bps / 100).toFixed(2)}%合同加点（条款v${tv.version}）`
  );
}

function buildInstallments({
  startDate,
  periods,
  balanceStart,
  segments,
  termsFn,
  tenor,
  freezeUntilPeriod = 0,
  frozen = [],
}) {
  const out = [];
  // balanceStart 必须是冻结边界（或放款）之后的本金；冻结期逐期结转，进入首个重算期前以此为准。
  let balance = balanceStart;
  let segIdx = 0;
  let payment = null;
  for (let p = 1; p <= periods; p++) {
    const pStart = addMonths(startDate, p - 1);
    const pEnd = addMonths(startDate, p);
    while (segments[segIdx].to !== null && pStart >= segments[segIdx].to) segIdx++;
    const seg = segments[segIdx];
    const tv = termsFn(pStart);

    if (p <= freezeUntilPeriod) {
      out.push(structuredClone(frozen.find((x) => x.period_no === p)));
      continue;
    }
    if (p === freezeUntilPeriod + 1) balance = balanceStart;

    const rate = seg.quote_id === null ? null : seg.quote_rate_bps + tv.spread_bps;
    if (seg.payReset && rate !== null) {
      const remaining = periods - p + 1;
      const mr = rate / 10_000 / 12;
      payment = roundCny((balance * mr * (1 + mr) ** remaining) / ((1 + mr) ** remaining - 1));
    }
    const days = daysBetween(pStart, pEnd);
    const interest = rate === null ? null : roundCny((balance * (rate / 10_000) * days) / 365);
    let principal = rate === null ? null : payment - interest;
    if (rate !== null && p !== periods) principal = Math.min(principal, balance);
    if (rate !== null && p === periods) principal = balance; // 末期轧差

    out.push({
      period_no: p,
      period_start: pStart,
      period_end: pEnd,
      due_date: pEnd,
      adjusted_due_date: following(pEnd) === pEnd ? null : following(pEnd),
      rate_snapshot: {
        repricing_date: seg.repricing_date,
        repricing_date_adjusted: seg.repricing_date_adjusted,
        quote_id: seg.quote_id,
        benchmark_tenor: tenor,
        quote_rate_bps: seg.quote_rate_bps,
        spread_bps: tv.spread_bps,
        effective_rate_bps: rate,
        terms_version: tv.version,
        formula: formulaText({ p, seg, tv, tenor }),
      },
      principal_cents: principal,
      interest_cents: interest,
      balance_before_cents: rate === null ? null : balance,
    });
    if (principal !== null) balance -= principal;
  }
  return out;
}

// ---------- 主装配 ----------
function buildAll(quotes, contracts) {
  const schedules = [];
  const events = [];
  const entries = [];
  const deliveries = [];

  const lastLive = (cid) =>
    schedules.filter((x) => x.contract_id === cid && x.status !== "abandoned").at(-1);

  // ===== 合同 A：5Y+，按年（放款对应日）重定价；2025 利率转换并发；2026 提前还款 =====
  const A = contracts[0];
  const aStart = A.start_date;
  const aPeriods = monthsBetween(aStart, A.maturity_date);
  const aRepricing = ["2023-09-25", "2024-09-25", "2025-09-25", "2026-09-25", "2027-09-25"];
  const aTermsFn = (date) => termsAt(A, date);
  const aSegments = (asOfTs) =>
    aRepricing.map((r, i) => {
      const adjusted = following(r);
      // 仅当名义重定价日已经到达（批次运行时点不早于该日）才取价；未来重定价段保持未知。
      const known = r <= asOfTs.slice(0, 10);
      const q = known ? effectiveQuoteAt(quotes, "5Y+", adjusted, asOfTs) : null;
      return {
        from: r,
        to: aRepricing[i + 1] ?? null,
        repricing_date: r,
        repricing_date_adjusted: adjusted,
        quote_id: q?.quote_id ?? null,
        quote_rate_bps: q?.rate_bps ?? null,
        payReset: true,
      };
    });

  const aVersion = ({
    ver,
    id,
    nominalDate,
    createdAt,
    status,
    supersededAt,
    origin,
    eventId,
    idem,
    basisTermsVersion,
    termsFn,
    balanceOverride = null,
    freezeMode = "before_repricing",
    freezeDate = nominalDate,
  }) => {
    const prev = lastLive(A.contract_id);
    const frozen = prev ? prev.installments : [];
    const freezeN = frozen.length
      ? freezeMode === "posted_through"
        ? frozen.filter((x) => (x.adjusted_due_date ?? x.due_date) <= freezeDate).length
        : frozen.filter((x) => x.period_start < freezeDate).length
      : 0;
    const carriedBalance = freezeN
      ? frozen[freezeN - 1].balance_before_cents - frozen[freezeN - 1].principal_cents
      : A.principal_cents;
    schedules.push({
      schedule_id: id,
      contract_id: A.contract_id,
      version: ver,
      status,
      created_at: createdAt,
      official_from: status === "abandoned" ? null : nominalDate,
      superseded_at: supersededAt,
      origin,
      change_event_id: eventId,
      idempotency_key: idem,
      basis: { generated_at_quote_set: `quotes-visible-as-of-${createdAt}`, terms_version_at_generation: basisTermsVersion },
      installments: buildInstallments({
        startDate: aStart,
        periods: aPeriods,
        balanceStart: balanceOverride ?? carriedBalance,
        segments: aSegments(createdAt),
        termsFn,
        tenor: "5Y+",
        freezeUntilPeriod: freezeN,
        frozen,
      }),
    });
  };

  // 放款首版
  aVersion({
    ver: 1, id: "SC-A-V1", nominalDate: aStart, createdAt: ts(aStart, "11:05:00"),
    status: "superseded", supersededAt: ts("2024-09-25", "10:00:00"),
    origin: "disbursement", eventId: null, idem: "IDEMP-SC-A-DISB",
    basisTermsVersion: 1, termsFn: aTermsFn,
  });

  // 2024 年度批量重定价
  events.push({
    event_id: "E-A-REPR-2024",
    contract_id: A.contract_id,
    type: "schedule_adjustment",
    occurred_at: ts("2024-09-25", "10:00:00"),
    effective_date: "2024-09-25",
    approved_by: "系统自动（批量重定价任务 BATCH-LPR-ANNUAL）",
    approval_ref: "BATCH-20240925-A-0001",
    origin: "batch_repricing",
    idempotency_key: "IDEMP-E-A-REPR-2024",
    detail: { repricing_date: "2024-09-25", quote_before: "Q-5Y+-2023-08", quote_after: "Q-5Y+-2024-07", rate_bps_before: 450, rate_bps_after: 435 },
  });
  aVersion({
    ver: 2, id: "SC-A-V2", nominalDate: "2024-09-25", createdAt: ts("2024-09-25", "10:00:00"),
    status: "superseded", supersededAt: ts("2025-09-25", "10:05:00"),
    origin: "batch_repricing", eventId: "E-A-REPR-2024", idem: "IDEMP-SC-A-REPR-2024",
    basisTermsVersion: 1, termsFn: aTermsFn,
  });

  // 2025-09-24 客户利率转换批准（加点 +50 → -10），次日生效
  events.push({
    event_id: "E-A-TERMS-2025",
    contract_id: A.contract_id,
    type: "terms_change",
    occurred_at: ts("2025-09-24", "16:30:00"),
    effective_date: "2025-09-25",
    approved_by: "零售信贷审批岗 LI/M2230",
    approval_ref: "APV-CONV-20250924-007",
    origin: "customer_channel",
    idempotency_key: "IDEMP-E-A-TERMS-2025",
    detail: {
      change_kind: "rate_conversion_spread_renewal",
      spread_bps_before: 50,
      spread_bps_after: -10,
      note: "客户申请利率转换并重新核定加减点；基准品种与重定价频率不变，自重定价日起适用",
    },
  });
  // 并发落败方：批量任务基于旧条款v1产出草稿，提交时发现条款已推进，废弃，从未正式。
  events.push({
    event_id: "E-A-REPR-2025-BATCH",
    contract_id: A.contract_id,
    type: "schedule_adjustment",
    occurred_at: ts("2025-09-25", "10:00:00"),
    effective_date: "2025-09-25",
    approved_by: "系统自动（批量重定价任务 BATCH-LPR-ANNUAL）",
    approval_ref: "BATCH-20250925-A-0001",
    origin: "batch_repricing",
    idempotency_key: "IDEMP-E-A-REPR-2025-BATCH",
    detail: {
      outcome: "abandoned_concurrent_terms_change",
      abandoned_schedule_id: "SC-A-V3-DRAFT",
      winner_event_id: "E-A-TERMS-2025",
      note: "提交时合同条款已由客户变更推进至v2，本批次草稿废弃，未成为正式计划",
    },
  });
  aVersion({
    ver: 3, id: "SC-A-V3-DRAFT", nominalDate: "2025-09-25", createdAt: ts("2025-09-25", "10:00:00"),
    status: "abandoned", supersededAt: null,
    origin: "batch_repricing", eventId: "E-A-REPR-2025-BATCH", idem: "IDEMP-SC-A-REPR-2025-BATCH",
    basisTermsVersion: 1, termsFn: () => A.terms_versions[0], // 锁定旧条款，故与胜出版本利率不同
  });
  // 并发胜出方：客户变更渠道，按条款v2生成，成为唯一正式计划
  aVersion({
    ver: 4, id: "SC-A-V4", nominalDate: "2025-09-25", createdAt: ts("2025-09-25", "10:05:00"),
    status: "superseded", supersededAt: ts("2026-03-25", "10:00:00"),
    origin: "customer_channel", eventId: "E-A-TERMS-2025", idem: "IDEMP-SC-A-TERMS-2025",
    basisTermsVersion: 2, termsFn: aTermsFn,
  });

  // 2026-03-25 提前还款 20 万元，期限不变、降低月供，仅重算未来期
  events.push({
    event_id: "E-A-PREPAY-2026",
    contract_id: A.contract_id,
    type: "prepayment",
    occurred_at: ts("2026-03-12", "10:02:00"),
    effective_date: "2026-03-25",
    approved_by: "客户经理 WANG/Q3095；放款复核 ZHAO/R1180",
    approval_ref: "APV-PREP-20260312-041",
    origin: "customer_channel",
    idempotency_key: "IDEMP-E-A-PREPAY-2026",
    detail: {
      prepayment_amount_cents: 20_000_000,
      settle_to_date: "2026-03-25",
      term_handling: "keep_maturity_reduce_payment",
      note: "提前还款仅冲减本金并重算2026-03-25及以后未来期；历史已入账期间不变",
    },
  });
  {
    const prev = lastLive(A.contract_id); // V4
    const frozen = prev.installments;
    const freezeN = frozen.filter((x) => x.period_start < "2026-03-25").length;
    const balanceAt = frozen[freezeN - 1].balance_before_cents - frozen[freezeN - 1].principal_cents;
    aVersion({
      ver: 5, id: "SC-A-V5", nominalDate: "2026-03-25", createdAt: ts("2026-03-25", "10:00:00"),
      status: "superseded", supersededAt: ts("2026-09-25", "10:00:00"),
      origin: "customer_channel", eventId: "E-A-PREPAY-2026", idem: "IDEMP-SC-A-PREPAY-2026",
      basisTermsVersion: 2, termsFn: aTermsFn,
      balanceOverride: balanceAt - 20_000_000,
    });
  }

  // 2026-09-25 年度批量重定价（当前正式版本）
  events.push({
    event_id: "E-A-REPR-2026",
    contract_id: A.contract_id,
    type: "schedule_adjustment",
    occurred_at: ts("2026-09-25", "10:00:00"),
    effective_date: "2026-09-25",
    approved_by: "系统自动（批量重定价任务 BATCH-LPR-ANNUAL）",
    approval_ref: "BATCH-20260925-A-0001",
    origin: "batch_repricing",
    idempotency_key: "IDEMP-E-A-REPR-2026",
    detail: { repricing_date: "2026-09-25", quote_after: "Q-5Y+-2026-05", quote_rate_bps: 380, spread_bps: -10, rate_bps_after: 370, terms_version: 2 },
  });
  aVersion({
    ver: 6, id: "SC-A-V6", nominalDate: "2026-09-25", createdAt: ts("2026-09-25", "10:00:00"),
    status: "official", supersededAt: null,
    origin: "batch_repricing", eventId: "E-A-REPR-2026", idem: "IDEMP-SC-A-REPR-2026",
    basisTermsVersion: 2, termsFn: aTermsFn,
  });

  // ===== 合同 B：1Y，按季（每月20日规则）重定价；含 2024-12 报价勘误与历史冲正 =====
  const B = contracts[1];
  const bStart = B.start_date;
  const bPeriods = monthsBetween(bStart, B.maturity_date);
  const bRepricing = [];
  for (let k = 0; ; k++) {
    const r = addMonths(bStart, k * 3);
    if (r >= B.maturity_date) break;
    bRepricing.push(r);
  }
  const bTermsFn = () => B.terms_versions[0];
  const bSegments = (asOfTs) =>
    bRepricing.map((r, i) => {
      const adjusted = following(r);
      const known = r <= asOfTs.slice(0, 10);
      const q = known ? effectiveQuoteAt(quotes, "1Y", adjusted, asOfTs) : null;
      return {
        from: r,
        to: bRepricing[i + 1] ?? null,
        repricing_date: r,
        repricing_date_adjusted: adjusted,
        quote_id: q?.quote_id ?? null,
        quote_rate_bps: q?.rate_bps ?? null,
        payReset: true,
      };
    });

  const bVersion = ({
    ver, id, nominalDate, createdAt, status, supersededAt, origin, eventId, idem,
    freezeDate = nominalDate, freezeMode = "before_repricing",
  }) => {
    const prev = schedules.filter((x) => x.contract_id === B.contract_id).at(-1);
    const frozen = prev ? prev.installments : [];
    const freezeN = !prev
      ? 0
      : freezeMode === "posted_through"
        ? frozen.filter((x) => (x.adjusted_due_date ?? x.due_date) <= freezeDate).length
        : frozen.filter((x) => x.period_start < freezeDate).length;
    const balanceAt = freezeN
      ? frozen[freezeN - 1].balance_before_cents - frozen[freezeN - 1].principal_cents
      : B.principal_cents;
    schedules.push({
      schedule_id: id,
      contract_id: B.contract_id,
      version: ver,
      status,
      created_at: createdAt,
      official_from: status === "abandoned" ? null : nominalDate,
      superseded_at: supersededAt,
      origin,
      change_event_id: eventId,
      idempotency_key: idem,
      basis: { generated_at_quote_set: `quotes-visible-as-of-${createdAt}`, terms_version_at_generation: 1 },
      installments: buildInstallments({
        startDate: bStart,
        periods: bPeriods,
        balanceStart: balanceAt,
        segments: bSegments(createdAt),
        termsFn: bTermsFn,
        tenor: "1Y",
        freezeUntilPeriod: freezeN,
        frozen,
      }),
    });
  };

  // 放款首版（345-30=315bp）
  bVersion({
    ver: 1, id: "SC-B-V1", nominalDate: bStart, createdAt: ts(bStart, "11:00:00"),
    status: "superseded", supersededAt: ts("2024-09-20", "10:00:00"),
    origin: "disbursement", eventId: null, idem: "IDEMP-SC-B-DISB",
  });

  const bRepricingEvent = (eventId, nominal, createdAt, extra = {}) => {
    const adjusted = following(nominal);
    events.push({
      event_id: eventId,
      contract_id: B.contract_id,
      type: "schedule_adjustment",
      occurred_at: createdAt,
      effective_date: nominal,
      approved_by: "系统自动（批量重定价任务 BATCH-LPR-QUARTERLY）",
      approval_ref: `BATCH-${nominal.replaceAll("-", "")}-B-0002`,
      origin: "batch_repricing",
      idempotency_key: `IDEMP-${eventId}`,
      detail: { repricing_date: nominal, repricing_date_adjusted: adjusted, ...extra },
    });
  };

  // 2024-09-20（周五，当日09:15报价330，执行300）
  bRepricingEvent("E-B-REPR-2024-09", "2024-09-20", ts("2024-09-20", "10:00:00"), {
    quote_after: "Q-1Y-2024-09", rate_bps_after: 300,
  });
  bVersion({
    ver: 2, id: "SC-B-V2", nominalDate: "2024-09-20", createdAt: ts("2024-09-20", "10:00:00"),
    status: "superseded", supersededAt: ts("2024-12-20", "10:00:00"),
    origin: "batch_repricing", eventId: "E-B-REPR-2024-09", idem: "IDEMP-SC-B-REPR-2024-09",
  });

  // 2024-12-20（周五）：首发310，执行280；期7按280入账
  bRepricingEvent("E-B-REPR-2024-12", "2024-12-20", ts("2024-12-20", "10:00:00"), {
    quote_after: "Q-1Y-2024-12", rate_bps_after: 280,
  });
  bVersion({
    ver: 3, id: "SC-B-V3", nominalDate: "2024-12-20", createdAt: ts("2024-12-20", "10:00:00"),
    status: "superseded", supersededAt: ts("2025-01-22", "14:00:00"),
    origin: "batch_repricing", eventId: "E-B-REPR-2024-12", idem: "IDEMP-SC-B-REPR-2024-12",
  });

  // 2024-12-23 勘误315；2025-01-22 对已入账期7做红冲蓝补，期8起按285重算未来期
  events.push({
    event_id: "E-B-CORRECT-2025-01",
    contract_id: B.contract_id,
    type: "rate_correction",
    occurred_at: ts("2025-01-22", "13:40:00"),
    effective_date: "2025-01-22",
    approved_by: "计财部利率管理岗 SUN/Y0521",
    approval_ref: "APV-ERRC-20250122-002",
    origin: "policy_correction",
    idempotency_key: "IDEMP-E-B-CORRECT-2025-01",
    detail: {
      tenor: "1Y",
      original_quote_id: "Q-1Y-2024-12",
      original_rate_bps: 310,
      corrected_quote_id: "Q-1Y-2024-12-ERR",
      corrected_rate_bps: 315,
      spread_bps: -30,
      rate_bps_before: 280,
      rate_bps_after: 285,
      posted_periods_corrected_by_reversal: [7],
      future_periods_regenerated_from: 8,
      notice_ref: "SHIBOR-LPR-A-202412-E",
    },
  });
  bVersion({
    ver: 4, id: "SC-B-V4", nominalDate: "2025-01-22", createdAt: ts("2025-01-22", "14:00:00"),
    status: "superseded", supersededAt: ts("2025-03-20", "10:00:00"),
    origin: "policy_correction", eventId: "E-B-CORRECT-2025-01", idem: "IDEMP-SC-B-CORRECT-2025-01",
    freezeDate: "2025-01-22", freezeMode: "posted_through", // 仅冻结已入账期1..7；期8起重算
  });

  // 后续按季批量（名义20日落周末时，顺延工作日取价并生成）
  const later = [
    ["2025-03-20", "SC-B-V5", 5, "2025-03-20"],
    ["2025-06-20", "SC-B-V6", 6, "2025-06-20"],
    ["2025-09-20", "SC-B-V7", 7, "2025-09-22"],
    ["2025-12-20", "SC-B-V8", 8, "2025-12-22"],
    ["2026-03-20", "SC-B-V9", 9, "2026-03-20"],
    ["2026-06-20", "SC-B-V10", 10, "2026-06-22"],
    ["2026-09-20", "SC-B-V11", 11, "2026-09-21"],
  ];
  later.forEach(([nominal, id, ver, genDate], i) => {
    const last = i === later.length - 1;
    const eventId = `E-B-REPR-${nominal.replaceAll("-", "")}`;
    const createdAt = ts(genDate, "10:00:00");
    if (!last) {
      bRepricingEvent(eventId, nominal, createdAt, { quote_after: null });
    } else {
      // 当前正式版本同样保留重定价事件痕迹
      bRepricingEvent(eventId, nominal, createdAt, { quote_after: "Q-1Y-2026-09", rate_bps_after: 270 });
    }
    bVersion({
      ver, id, nominalDate: nominal, createdAt,
      status: last ? "official" : "superseded",
      supersededAt: last ? null : ts(later[i + 1][3], "10:00:00"),
      origin: "batch_repricing", eventId, idem: `IDEMP-${id}`,
    });
  });

  // ===== 入账：按每个应还款日当时正式的计划登记原始利息 =====
  const AS_OF = "2026-09-26";
  const officialAt = (cid, date) =>
    schedules
      .filter((s) => s.contract_id === cid && s.status !== "abandoned" && s.official_from !== null && s.official_from <= date)
      .sort((x, y) => (x.official_from < y.official_from ? 1 : -1))[0];

  let seq = 0;
  for (const c of contracts) {
    const current = schedules.find((s) => s.contract_id === c.contract_id && s.status === "official");
    for (const inst of current.installments) {
      const valueDate = inst.adjusted_due_date ?? inst.due_date;
      if (valueDate > AS_OF || inst.interest_cents === null) continue;
      const sc = officialAt(c.contract_id, valueDate);
      const src = sc.installments.find((x) => x.period_no === inst.period_no) ?? inst;
      seq++;
      entries.push({
        entry_id: `JE-${String(seq).padStart(4, "0")}`,
        contract_id: c.contract_id,
        schedule_id: sc.schedule_id,
        period_no: src.period_no,
        kind: "interest_original",
        amount_cents: src.interest_cents,
        posted_at: ts(valueDate, "18:00:00"),
        value_date: valueDate,
        status: "posted",
        idempotency_key: `IDEMP-JE-${c.contract_id}-P${String(src.period_no).padStart(2, "0")}`,
        rate_quote_id: src.rate_snapshot.quote_id,
        terms_version: src.rate_snapshot.terms_version,
        reversal_of: null,
        correction_of: null,
        change_event_id: null,
      });
    }
  }

  // B 期7：勘误冲正——红冲（-原额）+ 蓝补（按285与同区间天数重算），原入账置 reversed 但不删除
  {
    const original = entries.find((e) => e.contract_id === B.contract_id && e.period_no === 7);
    original.status = "reversed";
    const inst7 = schedules.find((s) => s.schedule_id === "SC-B-V3").installments.find((x) => x.period_no === 7);
    const days = daysBetween(inst7.period_start, inst7.period_end);
    const corrected = roundCny((inst7.balance_before_cents * (285 / 10_000) * days) / 365);
    seq++;
    entries.push({
      entry_id: `JE-${String(seq).padStart(4, "0")}`,
      contract_id: B.contract_id,
      schedule_id: "SC-B-V3",
      period_no: 7,
      kind: "reversal",
      amount_cents: -original.amount_cents,
      posted_at: ts("2025-01-22", "14:05:00"),
      value_date: "2025-01-22",
      status: "posted",
      idempotency_key: "IDEMP-JE-LN-B-2024-0002-P07-REV",
      rate_quote_id: "Q-1Y-2024-12",
      terms_version: 1,
      reversal_of: original.entry_id,
      correction_of: null,
      change_event_id: "E-B-CORRECT-2025-01",
    });
    seq++;
    entries.push({
      entry_id: `JE-${String(seq).padStart(4, "0")}`,
      contract_id: B.contract_id,
      schedule_id: "SC-B-V4",
      period_no: 7,
      kind: "correction",
      amount_cents: corrected,
      posted_at: ts("2025-01-22", "14:05:00"),
      value_date: "2025-01-22",
      status: "posted",
      idempotency_key: "IDEMP-JE-LN-B-2024-0002-P07-COR",
      rate_quote_id: "Q-1Y-2024-12-ERR",
      terms_version: 1,
      reversal_of: null,
      correction_of: original.entry_id,
      change_event_id: "E-B-CORRECT-2025-01",
    });
  }

  // ===== 入站消息投递台账（重复投递只生效一次；含一次先失败后重试成功） =====
  deliveries.push(
    {
      message_id: "MSG-LPR-1Y-20241220-0915",
      topic: "lpr_quote_published",
      contract_id: null,
      first_received_at: ts("2024-12-20", "09:15:02"),
      attempts: [{ received_at: ts("2024-12-20", "09:15:02"), handler: "quote-ingest/primary", outcome: "processed" }],
      processed: true,
      result_ref: "Q-1Y-2024-12",
    },
    {
      message_id: "MSG-LPR-1Y-20241223-ERR",
      topic: "lpr_quote_corrected",
      contract_id: null,
      first_received_at: ts("2024-12-23", "09:30:10"),
      attempts: [
        { received_at: ts("2024-12-23", "09:30:10"), handler: "quote-ingest/primary", outcome: "processed" },
        { received_at: ts("2024-12-24", "08:12:44"), handler: "quote-ingest/primary", outcome: "duplicate_skipped" },
      ],
      processed: true,
      result_ref: "Q-1Y-2024-12-ERR",
    },
    {
      message_id: "MSG-LPR-5Y-20260520-0915",
      topic: "lpr_quote_published",
      contract_id: null,
      first_received_at: ts("2026-05-20", "09:15:01"),
      attempts: [
        { received_at: ts("2026-05-20", "09:15:01"), handler: "quote-ingest/primary", outcome: "failed_retryable" },
        { received_at: ts("2026-05-20", "09:31:18"), handler: "quote-ingest/retry", outcome: "processed" },
      ],
      processed: true,
      result_ref: "Q-5Y+-2026-05",
    },
    {
      message_id: "MSG-A-TERMS-20250924-1630",
      topic: "contract_change",
      contract_id: A.contract_id,
      first_received_at: ts("2025-09-24", "16:30:20"),
      attempts: [{ received_at: ts("2025-09-24", "16:30:20"), handler: "loan-servicing/primary", outcome: "processed" }],
      processed: true,
      result_ref: "E-A-TERMS-2025",
    },
    {
      message_id: "MSG-A-PREPAY-20260312-1002",
      topic: "prepayment",
      contract_id: A.contract_id,
      first_received_at: ts("2026-03-12", "10:02:11"),
      attempts: [
        { received_at: ts("2026-03-12", "10:02:11"), handler: "loan-servicing/primary", outcome: "processed" },
        { received_at: ts("2026-03-12", "10:02:13"), handler: "loan-servicing/primary", outcome: "duplicate_skipped" },
        { received_at: ts("2026-03-13", "09:00:07"), handler: "loan-servicing/reconciliation-replay", outcome: "duplicate_skipped" },
      ],
      processed: true,
      result_ref: "E-A-PREPAY-2026",
    },
  );

  return { schedules, events, entries, deliveries };
}

// ---------- 输出 ----------
const quotes = buildQuotes();
const contracts = buildContracts();
const { schedules, events, entries, deliveries } = buildAll(quotes, contracts);

await mkdir(FX, { recursive: true });
const put = (name, data) => writeFile(join(FX, name), JSON.stringify(data, null, 2) + "\n", "utf8");
await put("lpr-quotes.json", { quotes });
await put("loan-contracts.json", { contracts });
await put("change-events.json", { events });
await put("repayment-schedules.json", { schedules });
await put("interest-entries.json", { entries });
await put("inbound-deliveries.json", { deliveries });

console.log(
  `quotes=${quotes.length} contracts=${contracts.length} schedules=${schedules.length} ` +
    `events=${events.length} entries=${entries.length} deliveries=${deliveries.length}`,
);
