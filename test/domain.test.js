import test from "node:test";
import assert from "node:assert/strict";
import { makeService, registerSample, sampleContract } from "./helpers.js";

test("报价按有效区间引用：发布日期不等于生效日期", () => {
  const { registry } = makeService();
  registry.publish({
    id: "P1-20250820",
    variety: "1Y",
    rateBp: 295,
    publishDate: "2025-08-20",
    effectiveFrom: "2025-08-21",
    source: "全国银行间同业拆借中心",
    approvedBy: "运营方",
  });
  // 发布日当天、生效日前，仍引用上一期报价
  assert.equal(registry.lprOn("1Y", "2025-08-20").id, "P1-20250520");
  assert.equal(registry.lprOn("1Y", "2025-08-21").rateBp, 295);
  // 当前数值在下一次发布前有效：上一期窗口止于新报价生效前一日
  assert.equal(registry.get("P1-20250520").effectiveTo, "2025-08-20");
  // 窗口不得重叠
  assert.throws(
    () =>
      registry.publish({
        id: "P1-OVERLAP",
        variety: "1Y",
        rateBp: 290,
        publishDate: "2025-08-21",
        effectiveFrom: "2025-08-21",
        source: "全国银行间同业拆借中心",
        approvedBy: "运营方",
      }),
    (error) => error.code === "WINDOW_OVERLAP",
  );
});

test("新报价仅影响满足合同条件的未来区间，已入账期次不变", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  const v1 = store.getOfficialPlan(contractId);
  // 首期：2025-01-15 当日有效 5Y+ LPR 3.60%，加减点 -20BP → 3.40%
  assert.equal(v1.periods[0].rateBp, 340);
  assert.equal(v1.periods[0].interestCents, 283333);
  // 下一重定价日 2026-01-15：按计划生成时已知报价预估为 3.50% - 20BP
  assert.equal(v1.periods[12].rateBp, 330);

  service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-02-17" });
  service.postDueInterest({ messageId: "M-DUE-1", contractId, periodIndex: 1, postingDate: "2025-03-17" });
  const postedBefore = JSON.stringify(store.postingsFor(contractId));

  // 新报价发布：5Y+ 降至 3.45%
  service.publishLpr({
    messageId: "M-PUB-345",
    id: "P5-20251220",
    variety: "5Y_PLUS",
    rateBp: 345,
    publishDate: "2025-12-20",
    effectiveFrom: "2025-12-20",
    source: "全国银行间同业拆借中心",
    approvedBy: "运营方",
  });
  const batch = service.runBatchRepricing({ messageId: "M-BATCH-1", asOfDate: "2025-12-21", contractIds: [contractId] });
  assert.deepEqual(batch.result.results, [{ contractId, status: "REPRICED", planVersion: 2 }]);

  const v2 = store.getOfficialPlan(contractId);
  // 已入账期次原样保留
  assert.deepEqual(v2.periods[0], v1.periods[0]);
  assert.deepEqual(v2.periods[1], v1.periods[1]);
  // 未入账但重定价日未到的期次不受新报价影响（满足合同条件才重定价）
  for (let index = 2; index <= 11; index += 1) assert.deepEqual(v2.periods[index], v1.periods[index]);
  // 重定价日落在在新区间内的期次按新报价重定价：3.45% - 20BP = 3.25%
  assert.equal(v2.periods[12].rateBp, 325);
  assert.equal(v2.periods[12].rateFormation.publicationId, "P5-20251220");
  // 已入账利息不受任何影响
  assert.equal(JSON.stringify(store.postingsFor(contractId)), postedBefore);

  // 没有新报价时批量作业为无操作，不产生新版本
  const again = service.runBatchRepricing({ messageId: "M-BATCH-2", asOfDate: "2025-12-22", contractIds: [contractId] });
  assert.deepEqual(again.result.results, [{ contractId, status: "UNCHANGED", planVersion: 2 }]);
  assert.equal(store.getOfficialPlan(contractId).version, 2);
});

test("批量重定价与客户临时变更并发：一个合同只有一条正式计划", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";

  let slipped = false;
  const batch = service.runBatchRepricing({
    messageId: "M-BATCH-CONC",
    asOfDate: "2025-12-21",
    contractIds: [contractId],
    _interleave: (id, attempt) => {
      if (attempt !== 0 || slipped) return;
      slipped = true;
      // 客户变更抢先提交：加减点 -20BP → -60BP（此时新报价尚未发布）
      service.requestRateConversion({
        messageId: "M-CONV-1",
        contractId: id,
        effectiveFrom: "2026-01-15",
        spreadBp: -60,
        reason: "存量房贷利率转换",
        approvedBy: "审批岗B",
      });
      // 随后新报价才到达
      service.publishLpr({
        messageId: "M-PUB-345",
        id: "P5-20251220",
        variety: "5Y_PLUS",
        rateBp: 345,
        publishDate: "2025-12-20",
        effectiveFrom: "2025-12-20",
        source: "全国银行间同业拆借中心",
        approvedBy: "运营方",
      });
    },
  });

  // 批量作业基于旧版本提交被拒绝后，重读最新正式计划重试并生效
  assert.deepEqual(batch.result.results, [{ contractId, status: "REPRICED", planVersion: 3 }]);
  // 版本线性演进，任何时刻只有一条正式计划
  assert.deepEqual(store.planHistory(contractId).map((plan) => plan.version), [1, 2, 3]);
  const official = store.getOfficialPlan(contractId);
  assert.equal(official.version, 3);
  // 中间版本如实记录当时状态：客户变更已生效、新报价尚未发布（3.50% - 60BP）
  assert.equal(store.getPlan(contractId, 2).periods[12].rateBp, 290);
  // 最终正式计划同时包含两项变更：新报价 3.45% + 新加减点 -60BP
  assert.equal(official.periods[12].rateBp, 285);
  assert.equal(official.periods[12].rateFormation.spreadBp, -60);
  assert.equal(official.periods[12].rateFormation.publicationId, "P5-20251220");
  assert.equal(official.periods[12].rateFormation.termsVersion, 2);
  assert.equal(official.periods[0].rateFormation.termsVersion, 1);
});

test("消息重复投递不重复入账", () => {
  const { service, store, registry } = makeService();
  const publication = {
    messageId: "M-PUB-DUP",
    id: "P5-20251220",
    variety: "5Y_PLUS",
    rateBp: 345,
    publishDate: "2025-12-20",
    effectiveFrom: "2025-12-20",
    source: "全国银行间同业拆借中心",
    approvedBy: "运营方",
  };
  const first = service.publishLpr(publication);
  const second = service.publishLpr(publication);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(registry.history("5Y_PLUS").length, 3);

  registerSample(service);
  const contractId = "LN-T-0001";
  const posted = service.postDueInterest({ messageId: "M-DUE-DUP", contractId, periodIndex: 0, postingDate: "2025-02-17" });
  const replayed = service.postDueInterest({ messageId: "M-DUE-DUP", contractId, periodIndex: 0, postingDate: "2025-02-17" });
  assert.equal(posted.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(store.postingsFor(contractId).length, 1);
  // 第二道防线：不同消息标识对同一期次入账，被自然键拒绝
  assert.throws(
    () => service.postDueInterest({ messageId: "M-DUE-OTHER", contractId, periodIndex: 0, postingDate: "2025-02-17" }),
    (error) => error.code === "DUPLICATE_POSTING",
  );
  // 期次须顺序入账、到期后方可入账
  assert.throws(
    () => service.postDueInterest({ messageId: "M-DUE-SKIP", contractId, periodIndex: 2, postingDate: "2025-04-15" }),
    (error) => error.code === "POSTING_ORDER",
  );
  assert.throws(
    () => service.postDueInterest({ messageId: "M-DUE-EARLY", contractId, periodIndex: 1, postingDate: "2025-03-10" }),
    (error) => error.code === "PERIOD_NOT_DUE",
  );
});

test("勘误保留原记录，已入账利息经冲正与补记更正而非静默重算", () => {
  const { service, store, registry } = makeService();
  const contract = sampleContract({
    contractId: "LN-T-0002",
    startDate: "2025-06-10",
    termMonths: 24,
    terms: {
      variety: "5Y_PLUS",
      spreadBp: -20,
      repricingFrequencyMonths: 12,
      repricingRule: "ANNIVERSARY",
      effectiveFrom: "2025-06-10",
      reason: "放款",
      approvedBy: "审批岗A",
    },
  });
  service.registerContract({ messageId: "M-REG-2", ...contract });
  const contractId = "LN-T-0002";

  // 首期按 3.50% - 20BP = 3.30% 入账：利息 275000 分
  const posted = service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-07-10" });
  assert.equal(posted.result.interestCents, 275000);
  const originalSnapshot = JSON.stringify(store.getPosting(posted.result.postingId));

  // 发布机构勘误：3.50% 更正为 3.45%
  service.publishErrata({
    messageId: "M-ERR-1",
    id: "P5-20250520-C1",
    corrects: "P5-20250520",
    rateBp: 345,
    reason: "报价行数据录入错误",
    approvedBy: "运营方主管",
    publishDate: "2025-05-21",
  });
  // 原记录保留，勘误继承原有效区间，查询返回更正后数值
  assert.equal(registry.get("P5-20250520").rateBp, 350);
  assert.equal(registry.correctedBy("P5-20250520"), "P5-20250520-C1");
  assert.equal(registry.get("P5-20250520-C1").effectiveFrom, "2025-05-20");
  assert.equal(registry.lprOn("5Y_PLUS", "2025-06-10").rateBp, 345);

  // 影响评估：命中已入账的首期
  const impact = service.assessErrataImpact("P5-20250520-C1");
  assert.equal(impact.impactedPostings.length, 1);
  assert.equal(impact.impactedPostings[0].originalInterestCents, 275000);
  assert.equal(impact.impactedPostings[0].correctedInterestCents, 270833);

  const applied = service.applyErrataCorrection({ messageId: "M-ERR-APPLY", errataId: "P5-20250520-C1", approvedBy: "财务主管" });
  assert.equal(applied.result.corrections[0].deltaCents, -4167);
  assert.deepEqual(applied.result.repriced, [{ contractId, status: "REPRICED", planVersion: 2 }]);

  // 原入账记录字节级不变，更正以冲正+补记留痕
  assert.equal(JSON.stringify(store.getPosting(posted.result.postingId)), originalSnapshot);
  const postings = store.postingsFor(contractId);
  assert.equal(postings.length, 3);
  const reversal = postings.find((item) => item.kind === "REVERSAL");
  const repost = postings.find((item) => item.kind === "REPOST");
  assert.equal(reversal.interestCents, -275000);
  assert.equal(repost.interestCents, 270833);
  assert.equal(repost.principalCents, posted.result.principalCents);
  assert.equal(repost.amountCents, posted.result.amountCents - 4167);

  // 未来期次按勘误后报价重定价；已入账期次的利率形成快照保持原样
  const v2 = store.getOfficialPlan(contractId);
  assert.equal(v2.periods[0].rateFormation.publicationId, "P5-20250520");
  assert.equal(v2.periods[1].rateBp, 325);
  assert.equal(v2.periods[1].rateFormation.publicationId, "P5-20250520-C1");

  // 重复投递更正命令不产生二次冲正
  const replayed = service.applyErrataCorrection({ messageId: "M-ERR-APPLY", errataId: "P5-20250520-C1", approvedBy: "财务主管" });
  assert.equal(replayed.replayed, true);
  assert.equal(store.postingsFor(contractId).length, 3);
});

test("节假日顺延留下可解释轨迹，节假日安排更新生成新版本", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  const v1 = store.getOfficialPlan(contractId);
  // 2025-02-15 为周六，还款日顺延至 2025-02-17，逐日轨迹可查
  assert.equal(v1.periods[0].originalDueDate, "2025-02-15");
  assert.equal(v1.periods[0].dueDate, "2025-02-17");
  assert.deepEqual(v1.periods[0].holidayShifts, [
    { date: "2025-02-15", reason: "WEEKEND" },
    { date: "2025-02-16", reason: "WEEKEND" },
  ]);

  // 公布新的节假日安排：2026-01-15 为节假日
  service.updateCalendar({ messageId: "M-CAL-1", holidays: ["2026-01-15"] });
  const v2 = store.getOfficialPlan(contractId);
  assert.equal(v2.version, 2);
  assert.equal(v2.cause.type, "CALENDAR_UPDATED");
  assert.equal(v2.periods[11].originalDueDate, "2026-01-15");
  assert.equal(v2.periods[11].dueDate, "2026-01-16");
  assert.deepEqual(v2.periods[11].holidayShifts, [{ date: "2026-01-15", reason: "HOLIDAY" }]);
  // 其余期次不受影响
  assert.deepEqual(v2.periods[0], v1.periods[0]);
});

test("提前还款于还款日办理：本金入账、剩余重新摊还、历史期次不变", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-02-17" });
  service.postDueInterest({ messageId: "M-DUE-1", contractId, periodIndex: 1, postingDate: "2025-03-17" });
  service.postDueInterest({ messageId: "M-DUE-2", contractId, periodIndex: 2, postingDate: "2025-04-15" });
  const v1 = store.getOfficialPlan(contractId);

  // 非还款日不得办理；到期期次未入账不得办理
  assert.throws(
    () => service.requestEarlyRepayment({ messageId: "M-EARLY-BAD", contractId, effectiveDate: "2025-04-20", amountCents: 100, approvedBy: "审批岗B" }),
    (error) => error.code === "INVALID_EFFECTIVE_DATE",
  );

  const result = service.requestEarlyRepayment({
    messageId: "M-EARLY-1",
    contractId,
    effectiveDate: "2025-04-15",
    amountCents: 20000000,
    approvedBy: "审批岗B",
  });
  assert.equal(result.result.settled, false);

  // 本金入账，自然键防重
  const posting = store.getPosting(result.result.postingId);
  assert.equal(posting.kind, "EARLY_PRINCIPAL");
  assert.equal(posting.principalCents, 20000000);

  const v2 = store.getOfficialPlan(contractId);
  assert.equal(v2.version, 2);
  // 已入账期次原样保留
  for (let index = 0; index <= 2; index += 1) assert.deepEqual(v2.periods[index], v1.periods[index]);
  // 剩余本金自还款日起重新摊还，期限不变、月供下降
  assert.equal(v2.periods[3].accrualStart, "2025-04-15");
  assert.equal(v2.periods[3].openingPrincipalCents, v1.periods[2].closingPrincipalCents - 20000000);
  assert.equal(v2.periods.length, 360);
  assert.ok(v2.periods[3].paymentCents < v1.periods[3].paymentCents);
  // 本金守恒：已摊还 + 提前还款 + 剩余摊还 = 放款本金
  const amortized = v2.periods.reduce((sum, period) => sum + period.principalCents, 0);
  assert.equal(amortized + 20000000, 100000000);

  // 重复投递同一提前还款消息不产生第二笔本金入账
  const replayed = service.requestEarlyRepayment({
    messageId: "M-EARLY-1",
    contractId,
    effectiveDate: "2025-04-15",
    amountCents: 20000000,
    approvedBy: "审批岗B",
  });
  assert.equal(replayed.replayed, true);
  assert.equal(store.postingsFor(contractId).filter((item) => item.kind === "EARLY_PRINCIPAL").length, 1);
});

test("利率转换产生新条款版本，历史期次仍引用原条款", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-02-17" });

  // 已入账期次的边界不得作为变更生效日
  assert.throws(
    () =>
      service.requestRateConversion({
        messageId: "M-CONV-BAD",
        contractId,
        effectiveFrom: "2025-01-15",
        spreadBp: -60,
        reason: "存量房贷利率转换",
        approvedBy: "审批岗B",
      }),
    (error) => error.code === "INVALID_EFFECTIVE_DATE",
  );

  const result = service.requestRateConversion({
    messageId: "M-CONV-1",
    contractId,
    effectiveFrom: "2026-01-15",
    spreadBp: -60,
    reason: "存量房贷利率转换",
    approvedBy: "审批岗B",
  });
  assert.equal(result.result.termsVersion, 2);
  assert.equal(result.result.planVersion, 2);

  const contract = store.getContract(contractId);
  assert.equal(contract.terms.length, 2);
  assert.equal(contract.terms[0].spreadBp, -20);
  assert.equal(contract.terms[1].spreadBp, -60);
  assert.equal(contract.terms[1].approvedBy, "审批岗B");

  const v2 = store.getOfficialPlan(contractId);
  // 历史期次仍引用条款 v1，新条款只影响生效日之后的区间
  assert.equal(v2.periods[0].rateFormation.termsVersion, 1);
  assert.equal(v2.periods[0].rateFormation.spreadBp, -20);
  assert.equal(v2.periods[12].rateFormation.termsVersion, 2);
  assert.equal(v2.periods[12].rateBp, 290); // 3.50% - 60BP
});

test("已入账利息冻结保存，历史更正只能冲正", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-02-17" });
  const postingId = "POST-LN-T-0001-0-DUE";
  const posting = store.getPosting(postingId);

  // 入账记录写入即冻结，任何字段不可改写
  assert.ok(Object.isFrozen(posting));
  assert.throws(() => {
    posting.amountCents = 0;
  }, TypeError);
  const snapshot = JSON.stringify(posting);

  // 冲正：红字全额冲销，原记录保留
  const reversed = service.reversePosting({
    messageId: "M-REV-1",
    postingId,
    reason: "入账金额错误",
    approvedBy: "财务主管",
  });
  assert.equal(reversed.result.reversal.interestCents, -283333);
  assert.equal(JSON.stringify(store.getPosting(postingId)), snapshot);

  const explanation = service.explainPosting(postingId);
  assert.equal(explanation.reconciliation.netInterestCents, 0);

  // 同一笔入账不得重复冲正
  assert.throws(
    () => service.reversePosting({ messageId: "M-REV-2", postingId, reason: "重复冲正", approvedBy: "财务主管" }),
    (error) => error.code === "ALREADY_REVERSED",
  );
});

test("客户可查看每期利率形成，审计可从任意金额追到报价、条款与批准", () => {
  const { service, store } = makeService();
  registerSample(service);
  const contractId = "LN-T-0001";
  service.postDueInterest({ messageId: "M-DUE-0", contractId, periodIndex: 0, postingDate: "2025-02-17" });

  // 客户视角：逐期利率形成说明
  const view = service.rateFormationView(contractId, 0);
  assert.equal(view.variety, "5Y_PLUS");
  assert.equal(view.determinationDate, "2025-01-15");
  assert.equal(view.publicationId, "P5-20241220");
  assert.equal(view.publicationRateBp, 360);
  assert.equal(view.spreadBp, -20);
  assert.equal(view.finalRateBp, 340);
  assert.equal(view.source, "全国银行间同业拆借中心");
  assert.match(view.narrative, /五年期以上/);
  assert.match(view.narrative, /3\.40%/);
  assert.match(view.narrative, /-20BP/);
  assert.match(view.narrative, /顺延/); // 首期还款日遇周末顺延

  // 财务与审计视角：从入账金额追到当时有效的LPR、合同条款与批准变更
  const explanation = service.explainPosting("POST-LN-T-0001-0-DUE");
  assert.equal(explanation.posting.interestCents, 283333);
  assert.equal(explanation.publication.id, "P5-20241220");
  assert.equal(explanation.publication.source, "全国银行间同业拆借中心");
  assert.equal(explanation.contractTerms.version, 1);
  assert.equal(explanation.contractTerms.approvedBy, "审批岗A");
  assert.equal(explanation.reconciliation.netInterestCents, 283333);
  const eventTypes = explanation.events.map((event) => event.type);
  assert.ok(eventTypes.includes("CONTRACT_REGISTERED"));
  assert.ok(eventTypes.includes("DUE_INTEREST_POSTED"));
  assert.ok(store.planHistory(contractId).length >= 1);
});
