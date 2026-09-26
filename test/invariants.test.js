import test from "node:test";
import assert from "node:assert/strict";
import {
  loadDataset,
  effectiveQuoteAt,
  termsAt,
  officialSchedule,
  officialScheduleAsAt,
  explainPeriod,
  traceEntry,
  duplicateIdempotencyKeys,
  dayOf,
} from "../src/catalog.js";

// 独立的日历/计息工具（不复用生成脚本），用于交叉复算 fixtures 中的金额。
const DAY = 86_400_000;
const d = (s) => new Date(s + "T00:00:00Z");
const days = (a, b) => Math.round((d(b) - d(a)) / DAY);
const round = (x) => Math.round(x);
const addMonths = (s, n) => {
  const t = d(s);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, t.getUTCDate()))
    .toISOString().slice(0, 10);
};
const following = (s) => {
  const w = d(s).getUTCDay();
  if (w === 6) return new Date(d(s).getTime() + 2 * DAY).toISOString().slice(0, 10);
  if (w === 0) return new Date(d(s).getTime() + 1 * DAY).toISOString().slice(0, 10);
  return s;
};

let ds;
test.before(async () => {
  ds = await loadDataset();
});

const sc = (id) => ds.schedules.find((s) => s.schedule_id === id);
const period = (sid, n) => sc(sid).installments.find((i) => i.period_no === n);

// ---------- 1. 单一正式计划 ----------
test("同一合同当前至多一条 official 计划", () => {
  for (const c of ds.contracts) {
    const live = ds.schedules.filter((s) => s.contract_id === c.contract_id && s.status === "official");
    assert.equal(live.length, 1, `${c.contract_id} 应有且仅有一条 official`);
  }
});

test("利率适用时间轴：逐日扫描，每个日历日恰好一条管辖版本", () => {
  for (const cid of ds.contracts.map((c) => c.contract_id)) {
    const versions = ds.schedules
      .filter((s) => s.contract_id === cid && s.official_from !== null && s.status !== "abandoned")
      .sort((a, b) => a.official_from.localeCompare(b.official_from));
    let cursor = d(versions[0].official_from);
    const end = d("2026-09-26");
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      // 当日处于恰好一个 [official_from_i, official_from_{i+1}) 适用区间
      const active = versions.filter(
        (v, idx) => v.official_from <= date &&
          (idx === versions.length - 1 || date < versions[idx + 1].official_from),
      );
      assert.equal(active.length, 1, `${cid} ${date} 有 ${active.length} 条管辖版本`);
      assert.equal(officialSchedule(ds, cid, date).schedule_id, active[0].schedule_id);
      cursor = new Date(cursor.getTime() + DAY);
    }
  }
});

test("系统权威时间轴：版本权威窗口[created_at,superseded_at)首尾相接、不重叠", () => {
  // 周末顺延时新版本在顺延后的工作日才创建接管，故权威窗口与利率适用日可能相差一个周末。
  for (const cid of ds.contracts.map((c) => c.contract_id)) {
    const chain = ds.schedules
      .filter((s) => s.contract_id === cid && s.status !== "abandoned")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (let i = 1; i < chain.length; i++) {
      assert.equal(
        chain[i - 1].superseded_at,
        chain[i].created_at,
        `${cid} ${chain[i - 1].schedule_id} 权威窗口未与 ${chain[i].schedule_id} 相接`,
      );
      assert.ok(chain[i - 1].created_at < chain[i].created_at);
    }
    assert.equal(chain.at(-1).status, "official");
    assert.equal(chain.at(-1).superseded_at, null);
    // 落败草稿不在权威链上
    assert.ok(!chain.some((s) => s.status === "abandoned"));
  }
  // B：名义重定价日 2025-09-20（周六），V7 周一 10:00 才创建；创建前 V6 仍是系统权威
  assert.equal(officialScheduleAsAt(ds, "LN-B-2024-0002", "2025-09-22T09:59:59+08:00").schedule_id, "SC-B-V6");
  assert.equal(officialScheduleAsAt(ds, "LN-B-2024-0002", "2025-09-22T10:00:00+08:00").schedule_id, "SC-B-V7");
  // 当前时点两合同都持有唯一权威版本
  for (const cid of ["LN-A-2023-0001", "LN-B-2024-0002"]) {
    assert.equal(officialScheduleAsAt(ds, cid, "2026-09-26T12:00:00+08:00").status, "official");
  }
});

test("并发落败草稿为 abandoned 且从未正式；与胜出版本同日利率不同", () => {
  const draft = sc("SC-A-V3-DRAFT");
  assert.equal(draft.status, "abandoned");
  assert.equal(draft.official_from, null);
  assert.equal(period("SC-A-V3-DRAFT", 25).rate_snapshot.effective_rate_bps, 420); // 旧条款+50
  assert.equal(period("SC-A-V4", 25).rate_snapshot.effective_rate_bps, 360);       // 新条款-10
  // 落败方不能被任一时点选为正式计划
  for (const date of ["2025-09-25", "2026-01-01", "2026-09-26"]) {
    assert.notEqual(officialSchedule(ds, "LN-A-2023-0001", date).schedule_id, "SC-A-V3-DRAFT");
  }
});

// ---------- 2. 报价：来源、区间、勘误 ----------
test("每条报价保存授权发布来源", () => {
  for (const q of ds.quotes) {
    assert.equal(q.source.publisher, "全国银行间同业拆借中心");
    assert.ok(q.source.channel);
    assert.ok(q.source.notice_ref.match(/^SHIBOR-LPR-[AB]-/));
  }
});

test("同一期限品种的有效区间互不重叠（勘误以其发布时点接管）", () => {
  for (const tenor of ["1Y", "5Y+"]) {
    const rows = ds.quotes.filter((q) => q.tenor === tenor);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        // 仅当两个版本在同一时刻都“可见且有效”才算重叠
        const overlap =
          a.effective_from < (b.effective_to ?? "9999") &&
          b.effective_from < (a.effective_to ?? "9999") &&
          Math.max(a.publish_date, b.publish_date) < Math.min(a.effective_to ?? "9999", b.effective_to ?? "9999");
        if (overlap && a.supersedes_quote_id !== b.quote_id && b.supersedes_quote_id !== a.quote_id) {
          // 相邻常规发布允许在发布时点首尾相接（严格小于判断下为false）；此处重叠必须仅源于勘误对
          assert.fail(`非勘误报价区间重叠：${a.quote_id} / ${b.quote_id}`);
        }
      }
    }
  }
});

test("勘误版本回溯覆盖原区间并链接原报价；原版本置 corrected", () => {
  const err = ds.quotes.find((q) => q.quote_id === "Q-1Y-2024-12-ERR");
  const orig = ds.quotes.find((q) => q.quote_id === "Q-1Y-2024-12");
  assert.equal(err.version, 2);
  assert.equal(err.supersedes_quote_id, "Q-1Y-2024-12");
  assert.equal(err.rate_bps, 315);
  assert.equal(orig.rate_bps, 310);
  assert.equal(orig.status, "corrected");
  assert.equal(err.effective_from, orig.effective_from);
  assert.equal(orig.effective_to, err.publish_date);
});

test("勘误发布前取不到勘误值，发布后取价自动选勘误版本", () => {
  const before = effectiveQuoteAt(ds.quotes, "1Y", "2024-12-20", "2024-12-20T11:00:00+08:00");
  assert.equal(before.quote_id, "Q-1Y-2024-12");
  assert.equal(before.rate_bps, 310);
  const after = effectiveQuoteAt(ds.quotes, "1Y", "2024-12-20", "2024-12-23T10:00:00+08:00");
  assert.equal(after.quote_id, "Q-1Y-2024-12-ERR");
  assert.equal(after.rate_bps, 315);
});

test("发布日期与合同重定价日是两个概念：A合同按放款周年日重定价，引用的是更早发布的报价", () => {
  // 周年重定价日 2024-09-25 并非LPR发布日；当时有效的是 2024-07-22 发布的 3.85%
  const q = effectiveQuoteAt(ds.quotes, "5Y+", "2024-09-25");
  assert.equal(q.quote_id, "Q-5Y+-2024-07");
  assert.equal(q.rate_bps, 385);
  assert.equal(dayOf(q.publish_date), "2024-07-22");
});

// ---------- 3. 利率快照公式与取价正确性 ----------
test("每期快照满足 执行利率 = 取价日报价 + 合同加点", () => {
  for (const s of ds.schedules) {
    for (const i of s.installments) {
      const snap = i.rate_snapshot;
      if (snap.effective_rate_bps === null) continue;
      assert.equal(
        snap.effective_rate_bps,
        snap.quote_rate_bps + snap.spread_bps,
        `${s.schedule_id} p${i.period_no} 公式不平`,
      );
      const q = ds.quotes.find((x) => x.quote_id === snap.quote_id);
      assert.ok(q, `${s.schedule_id} p${i.period_no} 报价引用不存在`);
      assert.equal(q.tenor, snap.benchmark_tenor);
      // 取价日该报价必须有效
      const day = snap.repricing_date_adjusted;
      assert.ok(q.effective_from.slice(0, 10) <= day);
      assert.ok(q.effective_to === null || day < q.effective_to.slice(0, 10));
    }
  }
});

test("未到重定价日的期间利率快照为 null，且排在所有已知期之后", () => {
  for (const s of ds.schedules) {
    let seenNull = false;
    for (const i of s.installments) {
      const isNull = i.rate_snapshot.effective_rate_bps === null;
      if (isNull) seenNull = true;
      else assert.equal(seenNull, false, `${s.schedule_id} 已知期出现在未知期之后`);
    }
  }
});

test("快照报价版本不随后续勘误改变（期7历史仍引用原报价）", () => {
  assert.equal(period("SC-B-V4", 7).rate_snapshot.quote_id, "Q-1Y-2024-12");
  assert.equal(period("SC-B-V4", 7).rate_snapshot.quote_rate_bps, 310);
  assert.equal(period("SC-B-V4", 8).rate_snapshot.quote_id, "Q-1Y-2024-12-ERR");
});

// ---------- 4. 金额独立复算 ----------
test("利息金额可按 ACT/365 独立复算", () => {
  for (const s of ds.schedules) {
    for (const i of s.installments) {
      if (i.rate_snapshot.effective_rate_bps === null) continue;
      const n = days(i.period_start, i.period_end);
      const expected = round((i.balance_before_cents * (i.rate_snapshot.effective_rate_bps / 10_000) * n) / 365);
      assert.equal(i.interest_cents, expected, `${s.schedule_id} p${i.period_no} 利息复算不符`);
    }
  }
});

test("相邻已知期本金余额逐期结转；提前还款边界恰好跳减还款额；当前正式计划末期归零", () => {
  // 合同维度的提前还款跳变：版本会继承上一版的余额，跳变在后续所有版本同期存在。
  const jumpsByContract = new Map();
  for (const c of ds.contracts) {
    const jumps = ds.events
      .filter((e) => e.contract_id === c.contract_id && e.type === "prepayment")
      .map((e) => ({ date: e.effective_date, amount: e.detail.prepayment_amount_cents }));
    jumpsByContract.set(c.contract_id, jumps);
  }
  for (const s of ds.schedules) {
    const known = s.installments.filter((i) => i.rate_snapshot.effective_rate_bps !== null);
    // 版本只能反映其创建时点之前已批准的事件；落败草稿与旧版本不应套用它们“未来”的提前还款。
    const createdDay = s.created_at.slice(0, 10);
    const jumps = jumpsByContract.get(s.contract_id).filter((j) => j.date <= createdDay);
    for (let k = 1; k < known.length; k++) {
      const prev = known[k - 1];
      const cur = known[k];
      // 提前还款生效日落点在上期起息日（不含）至本期起息日（含）之间，形成余额跳减
      const hit = jumps.find((j) => prev.period_start < j.date && j.date <= cur.period_start);
      if (hit) {
        assert.equal(
          prev.balance_before_cents - prev.principal_cents - cur.balance_before_cents,
          hit.amount,
          `${s.schedule_id} p${cur.period_no} 提前还款跳减金额不符`,
        );
      } else {
        assert.equal(
          cur.balance_before_cents,
          prev.balance_before_cents - prev.principal_cents,
          `${s.schedule_id} p${cur.period_no} 余额结转不符`,
        );
      }
    }
    if (s.status === "official" && known.length === s.installments.length) {
      const last = known.at(-1);
      assert.equal(last.balance_before_cents - last.principal_cents, 0);
    }
  }
  // B 官方版全部期间已定价（3年/36期，最后重定价日2026-09已过）→ 末期必须归零
  const bOfficial = sc("SC-B-V11");
  const bLast = bOfficial.installments.at(-1);
  assert.equal(bLast.balance_before_cents - bLast.principal_cents, 0);
});

// ---------- 5. 新报价只影响未来区间；版本冻结历史 ----------
test("每次重定价/变更只重算边界之后的未来期，历史期与上一版逐字段一致", () => {
  const chains = [
    ["SC-A-V1", "SC-A-V2", "2024-09-25"],
    ["SC-A-V4", "SC-A-V5", "2026-03-25"],
    ["SC-A-V5", "SC-A-V6", "2026-09-25"],
    ["SC-B-V2", "SC-B-V3", "2024-12-20"],
    ["SC-B-V3", "SC-B-V4", null], // 勘误更正：冻结已入账期1..7
  ];
  for (const [prevId, nextId, boundary] of chains) {
    const prev = sc(prevId);
    const next = sc(nextId);
    const frozenCount =
      boundary === null
        ? 7
        : prev.installments.filter((i) => i.period_start < boundary).length;
    for (let p = 1; p <= frozenCount; p++) {
      assert.deepEqual(
        next.installments.find((i) => i.period_no === p),
        prev.installments.find((i) => i.period_no === p),
        `${prevId}→${nextId} 历史期 p${p} 被改动`,
      );
    }
  }
});

test("提前还款仅冲减本金20万：边界期余额减少、历史期不变、期限不变", () => {
  assert.deepEqual(
    period("SC-A-V4", 30),
    period("SC-A-V5", 30),
  );
  const before = period("SC-A-V4", 31).balance_before_cents;
  const after = period("SC-A-V5", 31).balance_before_cents;
  assert.equal(after, before - 20_000_000);
  assert.equal(sc("SC-A-V5").installments.length, sc("SC-A-V4").installments.length);
});

// ---------- 6. 条款版本与节假日顺延 ----------
test("合同条款按版本时点适用：转换前+50bp，转换后-10bp", () => {
  const A = ds.contracts.find((c) => c.contract_id === "LN-A-2023-0001");
  assert.equal(termsAt(A, "2025-09-24").version, 1);
  assert.equal(termsAt(A, "2025-09-25").version, 2);
  assert.equal(period("SC-A-V4", 24).rate_snapshot.terms_version, 1);
  assert.equal(period("SC-A-V4", 25).rate_snapshot.terms_version, 2);
  assert.equal(period("SC-A-V4", 25).rate_snapshot.spread_bps, -10);
  const ev = ds.events.find((e) => e.event_id === "E-A-TERMS-2025");
  assert.ok(ev.approval_ref && ev.approved_by);
});

test("重定价日落周六顺延至周一取价，引用报价与加点不变", () => {
  const snap = period("SC-B-V7", 16).rate_snapshot; // 名义 2025-09-20（周六）
  assert.equal(snap.repricing_date, "2025-09-20");
  assert.equal(snap.repricing_date_adjusted, "2025-09-22");
  assert.equal(snap.quote_id, "Q-1Y-2025-09"); // 周一 09:15 发布的报价
  assert.equal(snap.quote_rate_bps + snap.spread_bps, snap.effective_rate_bps);
  // 起息区间仍自名义日开始
  assert.equal(period("SC-B-V7", 16).period_start, "2025-09-20");
});

test("还款日遇周末记录实际顺延后日期", () => {
  // 2025-10-25 为周六
  assert.equal(period("SC-A-V4", 25).due_date, "2025-10-25");
  assert.equal(period("SC-A-V4", 25).adjusted_due_date, "2025-10-27");
  assert.equal(following("2025-10-25"), "2025-10-27");
});

// ---------- 7. 已入账利息不被静默重算；红冲蓝补成对 ----------
test("原始入账金额与其当时计划期利息一致（入账不被静默改写）", () => {
  for (const e of ds.entries) {
    if (e.kind !== "interest_original") continue;
    const s = sc(e.schedule_id);
    const inst = s.installments.find((i) => i.period_no === e.period_no);
    assert.equal(e.amount_cents, inst.interest_cents, `${e.entry_id} 金额与计划快照不符`);
    assert.equal(e.rate_quote_id, inst.rate_snapshot.quote_id);
    assert.equal(e.terms_version, inst.rate_snapshot.terms_version);
  }
});

test("勘误冲正成对登记：红冲=-原额、蓝补按285bp复算，原入账置reversed但保留", () => {
  const [orig] = ds.entries.filter(
    (e) => e.contract_id === "LN-B-2024-0002" && e.period_no === 7 && e.kind === "interest_original",
  );
  const rev = ds.entries.find((e) => e.reversal_of === orig.entry_id);
  const cor = ds.entries.find((e) => e.correction_of === orig.entry_id);
  assert.equal(orig.status, "reversed");
  assert.equal(rev.kind, "reversal");
  assert.equal(rev.amount_cents, -orig.amount_cents);
  assert.equal(cor.kind, "correction");
  assert.equal(rev.change_event_id, "E-B-CORRECT-2025-01");
  assert.equal(cor.change_event_id, "E-B-CORRECT-2025-01");
  const inst7 = period("SC-B-V3", 7);
  const n = days(inst7.period_start, inst7.period_end);
  const expected = round((inst7.balance_before_cents * (285 / 10_000) * n) / 365);
  assert.equal(cor.amount_cents, expected);
  assert.ok(cor.amount_cents !== orig.amount_cents);
  assert.equal(cor.rate_quote_id, "Q-1Y-2024-12-ERR");
  // 冲正后该期净影响 = 原入账 + 红冲 + 蓝补 = 正确金额（原入账保留但置 reversed）
  const net = ds.entries
    .filter((e) => e.contract_id === "LN-B-2024-0002" && e.period_no === 7)
    .reduce((sum, e) => sum + e.amount_cents, 0);
  assert.equal(net, expected);
});

// ---------- 8. 幂等与重复投递 ----------
test("入账/事件/计划/消息的幂等键全局无重复", () => {
  const dup = duplicateIdempotencyKeys(ds);
  assert.deepEqual(dup, { entries: [], events: [], schedules: [], deliveries: [] });
});

test("重复投递登记多次 attempt，但只产生一次业务效果", () => {
  const dlv = ds.deliveries.find((d) => d.message_id === "MSG-A-PREPAY-20260312-1002");
  assert.equal(dlv.attempts.length, 3);
  assert.equal(dlv.attempts.filter((a) => a.outcome === "processed").length, 1);
  assert.equal(dlv.attempts.filter((a) => a.outcome === "duplicate_skipped").length, 2);
  assert.equal(dlv.processed, true);
  assert.equal(dlv.result_ref, "E-A-PREPAY-2026");
  const events = ds.events.filter((e) => e.idempotency_key === "IDEMP-E-A-PREPAY-2026");
  assert.equal(events.length, 1);
});

test("先失败后重试成功的消息同样只入账一次效果", () => {
  const dlv = ds.deliveries.find((d) => d.message_id === "MSG-LPR-5Y-20260520-0915");
  assert.deepEqual(dlv.attempts.map((a) => a.outcome), ["failed_retryable", "processed"]);
  assert.equal(dlv.result_ref, "Q-5Y+-2026-05");
});

// ---------- 9. 引用完整性与全链路追溯 ----------
test("全部入账记录可完整追溯（无断链）", () => {
  for (const e of ds.entries) {
    const t = traceEntry(ds, e.entry_id);
    assert.equal(t.broken, false, `${e.entry_id} 追溯断链：${t.gaps.join("; ")}`);
    assert.ok(t.quote);
    assert.ok(t.contract_terms);
    assert.ok(t.period.snapshot);
  }
});

test("追溯链包含授权来源、报价版本、条款版本、批准变更", () => {
  const t = traceEntry(ds, ds.entries.find((e) => e.kind === "correction").entry_id);
  assert.equal(t.quote.source.publisher, "全国银行间同业拆借中心");
  assert.equal(t.quote.quote_id, "Q-1Y-2024-12-ERR");
  assert.equal(t.contract_terms.version, 1);
  assert.equal(t.approved_change.event_id, "E-B-CORRECT-2025-01");
  assert.equal(t.approved_change.approval_ref, "APV-ERRC-20250122-002");
  assert.ok(t.related_entries.some((r) => r.relation === "correction_of"));
});

test("客户视角解释包含每期利率形成叙述与金额", () => {
  const x = explainPeriod(ds, "LN-A-2023-0001", 37);
  assert.equal(x.rate.effective_rate_bps, 370);
  assert.equal(x.quote.quote_id, "Q-5Y+-2026-05");
  assert.equal(x.terms_version.version, 2);
  assert.match(x.narrative, /3.80%/);
  assert.match(x.narrative, /-0.10%/);
  assert.ok(x.amounts.interest_cents > 0);
  const xb = explainPeriod(ds, "LN-B-2024-0002", 7, "SC-B-V3");
  assert.match(xb.narrative, /3.10%/);
});

test("计划版本均记录来源（批量/客户/放款/勘误）与生成依据", () => {
  for (const s of ds.schedules) {
    assert.ok(["disbursement", "batch_repricing", "customer_channel", "policy_correction"].includes(s.origin));
    assert.ok(s.basis.generated_at_quote_set);
    assert.equal(typeof s.basis.terms_version_at_generation, "number");
    assert.ok(s.idempotency_key);
  }
});
