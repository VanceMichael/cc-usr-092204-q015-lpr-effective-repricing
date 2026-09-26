import { compareDates, parseDate } from "./dates.js";
import { DomainError, VersionConflict } from "./errors.js";
import { createContract, reviseTerms } from "./contract.js";
import { buildPlan, planFingerprint } from "./plan.js";
import { monthlyInterestCents } from "./money.js";

const MAX_RETRIES = 3;
const VARIETY_LABEL = { "1Y": "一年期", "5Y_PLUS": "五年期以上" };

// 应用服务：所有变更命令都经幂等收件箱进入，重复投递返回首次结果。
// 批量重定价与客户临时变更基于“期望版本”提交，冲突方重读重试，
// 由存储层保证一个合同只有一条正式计划。
export class BankService {
  constructor({ registry, calendar, store, clock }) {
    this.registry = registry;
    this.calendar = calendar;
    this.store = store;
    this.clock = clock ?? (() => new Date().toISOString());
  }

  // ---- LPR 报价与勘误 ----

  publishLpr({ messageId, ...payload }) {
    return this.store.processMessage(messageId, () => {
      const record = this.registry.publish(payload);
      this.store.appendEvent({
        type: "LPR_PUBLISHED",
        occurredAt: this.clock(),
        actor: payload.approvedBy,
        summary: `发布${record.variety} LPR ${record.rateBp}BP，${record.effectiveFrom} 起生效`,
        refs: { publicationId: record.id },
      });
      // 返回快照：登记表内部记录需随后续发布闭合窗口，不随收件箱冻结
      return { ...record };
    });
  }

  publishErrata({ messageId, ...payload }) {
    return this.store.processMessage(messageId, () => {
      const record = this.registry.publishErrata(payload);
      this.store.appendEvent({
        type: "LPR_ERRATA_PUBLISHED",
        occurredAt: this.clock(),
        actor: payload.approvedBy,
        summary: `勘误 ${record.corrects}：更正为 ${record.rateBp}BP，原因：${payload.reason}`,
        refs: { publicationId: record.id, corrects: record.corrects },
      });
      return { ...record };
    });
  }

  // ---- 合同登记 ----

  registerContract({ messageId, ...payload }) {
    return this.store.processMessage(messageId, () => {
      if (this.store.hasContract(payload.contractId)) {
        throw new DomainError("CONTRACT_EXISTS", `合同已存在：${payload.contractId}`);
      }
      const contract = createContract(payload);
      const plan = buildPlan({
        contract,
        registry: this.registry,
        calendar: this.calendar,
        version: 1,
        cause: { type: "CONTRACT_REGISTERED", messageId },
        asOf: this.clock(),
      });
      this.store.commit({
        contractId: contract.contractId,
        expectedPlanVersion: 0,
        newContract: contract,
        newPlan: plan,
        event: {
          type: "CONTRACT_REGISTERED",
          contractId: contract.contractId,
          occurredAt: this.clock(),
          actor: payload.terms.approvedBy,
          summary: `合同 ${contract.contractId} 放款登记，本金 ${contract.principalCents} 分`,
          refs: { planVersion: 1 },
        },
      });
      return { contractId: contract.contractId, planVersion: 1 };
    });
  }

  // ---- 批量重定价：只重算未入账期次，已入账期次原样保留 ----

  runBatchRepricing({ messageId, asOfDate, contractIds = null, _interleave = null }) {
    return this.store.processMessage(messageId, () => {
      const ids = contractIds ?? this.store.activeContractIds();
      const results = ids.map((contractId) =>
        this.#repriceContract(contractId, { type: "BATCH_REPRICING", messageId, asOfDate }, _interleave),
      );
      return { asOfDate, results };
    });
  }

  #repriceContract(contractId, cause, interleave) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const contract = this.store.getContract(contractId);
      const official = this.store.getOfficialPlan(contractId);
      interleave?.(contractId, attempt);
      const plan = buildPlan({
        contract,
        registry: this.registry,
        calendar: this.calendar,
        version: official.version + 1,
        cause,
        asOf: this.clock(),
        preservePeriods: this.#lockedPeriods(contractId, official),
      });
      if (planFingerprint(plan) === planFingerprint(official)) {
        return { contractId, status: "UNCHANGED", planVersion: official.version };
      }
      try {
        this.store.commit({
          contractId,
          expectedPlanVersion: official.version,
          newPlan: plan,
          event: {
            type: cause.type,
            contractId,
            occurredAt: this.clock(),
            actor: cause.actor ?? "批量作业",
            summary: `还款计划重定价至版本 ${plan.version}`,
            refs: { planVersion: plan.version },
          },
        });
        return { contractId, status: "REPRICED", planVersion: plan.version };
      } catch (error) {
        if (error instanceof VersionConflict) continue; // 与客户变更并发：重读最新正式计划重试
        throw error;
      }
    }
    throw new DomainError("REPRICING_CONFLICT_EXHAUSTED", `合同 ${contractId} 重定价多次冲突`);
  }

  // ---- 客户临时变更：利率转换（需批准，自未入账期次边界生效） ----

  requestRateConversion({ messageId, contractId, effectiveFrom, spreadBp, variety, reason, approvedBy }) {
    return this.store.processMessage(messageId, () => {
      parseDate(effectiveFrom);
      if (!approvedBy) throw new DomainError("VALIDATION_FAILED", "利率转换须登记批准人");
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const contract = this.store.getContract(contractId);
        this.#assertActive(contract);
        const official = this.store.getOfficialPlan(contractId);
        this.#assertUnlockedBoundary(contractId, official, effectiveFrom);
        const nextContract = reviseTerms(contract, { effectiveFrom, spreadBp, variety, reason, approvedBy });
        const plan = buildPlan({
          contract: nextContract,
          registry: this.registry,
          calendar: this.calendar,
          version: official.version + 1,
          cause: { type: "RATE_CONVERSION", messageId, reason },
          asOf: this.clock(),
          preservePeriods: this.#lockedPeriods(contractId, official),
        });
        try {
          this.store.commit({
            contractId,
            expectedPlanVersion: official.version,
            expectedTermsVersion: contract.terms.at(-1).version,
            newContract: nextContract,
            newPlan: plan,
            event: {
              type: "RATE_CONVERSION",
              contractId,
              occurredAt: this.clock(),
              actor: approvedBy,
              summary: `利率转换自 ${effectiveFrom} 生效：${reason}`,
              refs: { planVersion: plan.version, termsVersion: nextContract.terms.at(-1).version },
            },
          });
          return { contractId, planVersion: plan.version, termsVersion: nextContract.terms.at(-1).version };
        } catch (error) {
          if (error instanceof VersionConflict) continue;
          throw error;
        }
      }
      throw new DomainError("REPRICING_CONFLICT_EXHAUSTED", `合同 ${contractId} 利率转换多次冲突`);
    });
  }

  // ---- 提前还款：于还款日办理，到期期次须已入账；剩余本金自该日起重新摊还 ----

  requestEarlyRepayment({ messageId, contractId, effectiveDate, amountCents, approvedBy }) {
    return this.store.processMessage(messageId, () => {
      parseDate(effectiveDate);
      if (!approvedBy) throw new DomainError("VALIDATION_FAILED", "提前还款须登记批准人");
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DomainError("VALIDATION_FAILED", "提前还款金额须为正整数分");
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const contract = this.store.getContract(contractId);
        this.#assertActive(contract);
        const official = this.store.getOfficialPlan(contractId);
        const boundaryIndex = official.periods.findIndex((period) => period.accrualEnd === effectiveDate);
        if (boundaryIndex < 0) {
          throw new DomainError("INVALID_EFFECTIVE_DATE", `提前还款日 ${effectiveDate} 须为还款日`);
        }
        const posted = this.#postedDueIndexes(contractId);
        for (let index = 0; index <= boundaryIndex; index += 1) {
          if (!posted.has(index)) throw new DomainError("UNSETTLED_PERIODS", `第 ${index} 期尚未入账，须先结清到期期次`);
        }
        const outstanding = official.periods[boundaryIndex].closingPrincipalCents;
        if (amountCents > outstanding) throw new DomainError("INSUFFICIENT_BALANCE", `提前还款金额超过剩余本金 ${outstanding}`);
        const opening = outstanding - amountCents;
        const settled = opening === 0;
        const plan = buildPlan({
          contract,
          registry: this.registry,
          calendar: this.calendar,
          version: official.version + 1,
          cause: { type: "EARLY_REPAYMENT", messageId },
          asOf: this.clock(),
          preservePeriods: official.periods.slice(0, boundaryIndex + 1),
          openingBalanceCents: opening,
          remainingMonths: settled ? 0 : contract.termMonths - (boundaryIndex + 1),
        });
        const posting = {
          postingId: `POST-${contractId}-EARLY-${effectiveDate}`,
          contractId,
          kind: "EARLY_PRINCIPAL",
          naturalKey: `EARLY:${effectiveDate}`,
          periodIndex: null,
          planVersion: plan.version,
          amountCents,
          interestCents: 0,
          principalCents: amountCents,
          postingDate: effectiveDate,
          messageId,
          note: "提前还款本金",
        };
        const nextContract = settled ? { ...contract, status: "SETTLED" } : null;
        try {
          this.store.commit({
            contractId,
            expectedPlanVersion: official.version,
            expectedTermsVersion: nextContract ? contract.terms.at(-1).version : null,
            newContract: nextContract,
            newPlan: plan,
            postings: [posting],
            event: {
              type: "EARLY_REPAYMENT",
              contractId,
              occurredAt: this.clock(),
              actor: approvedBy,
              summary: `提前还款 ${amountCents} 分，自 ${effectiveDate} 重新摊还${settled ? "，合同结清" : ""}`,
              refs: { planVersion: plan.version, postingId: posting.postingId },
            },
          });
          return { contractId, planVersion: plan.version, postingId: posting.postingId, settled };
        } catch (error) {
          if (error instanceof VersionConflict) continue;
          throw error;
        }
      }
      throw new DomainError("REPRICING_CONFLICT_EXHAUSTED", `合同 ${contractId} 提前还款多次冲突`);
    });
  }

  // ---- 到期入账：按当期正式计划金额入账，期次顺序入账，入账后期次锁定 ----

  postDueInterest({ messageId, contractId, periodIndex, postingDate }) {
    return this.store.processMessage(messageId, () => {
      parseDate(postingDate);
      const official = this.store.getOfficialPlan(contractId);
      const period = official.periods[periodIndex];
      if (!period) throw new DomainError("PLAN_NOT_FOUND", `合同 ${contractId} 无第 ${periodIndex} 期`);
      const posted = this.#postedDueIndexes(contractId);
      if (posted.has(periodIndex)) {
        throw new DomainError("DUPLICATE_POSTING", `第 ${periodIndex} 期已入账，不得重复入账`);
      }
      const nextIndex = posted.size ? Math.max(...posted) + 1 : 0;
      if (periodIndex !== nextIndex) {
        throw new DomainError("POSTING_ORDER", `须按期次顺序入账，下一期为第 ${nextIndex} 期`);
      }
      if (compareDates(postingDate, period.dueDate) < 0) {
        throw new DomainError("PERIOD_NOT_DUE", `第 ${periodIndex} 期 ${period.dueDate} 到期，不得提前入账`);
      }
      const posting = {
        postingId: `POST-${contractId}-${periodIndex}-DUE`,
        contractId,
        kind: "DUE_INTEREST",
        naturalKey: `DUE:${periodIndex}`,
        periodIndex,
        planVersion: official.version,
        amountCents: period.paymentCents,
        interestCents: period.interestCents,
        principalCents: period.principalCents,
        postingDate,
        messageId,
      };
      this.store.commit({
        contractId,
        postings: [posting],
        event: {
          type: "DUE_INTEREST_POSTED",
          contractId,
          occurredAt: this.clock(),
          actor: "账务作业",
          summary: `第 ${periodIndex} 期入账：利息 ${period.interestCents} 分、本金 ${period.principalCents} 分`,
          refs: { postingId: posting.postingId, planVersion: official.version },
        },
      });
      return posting;
    });
  }

  // ---- 历史冲正：红字冲销原入账，可附蓝字补记；原记录保留，更正全程留痕 ----

  reversePosting({ messageId, postingId, reason, approvedBy, repost = null }) {
    return this.store.processMessage(messageId, () => {
      if (!reason) throw new DomainError("VALIDATION_FAILED", "冲正原因必填");
      if (!approvedBy) throw new DomainError("VALIDATION_FAILED", "冲正须登记批准人");
      const original = this.store.getPosting(postingId);
      const siblings = this.store.postingsFor(original.contractId);
      if (siblings.some((posting) => posting.kind === "REVERSAL" && posting.reversesPostingId === postingId)) {
        throw new DomainError("ALREADY_REVERSED", `入账 ${postingId} 已被冲正`);
      }
      const postingDate = this.clock().slice(0, 10);
      const reversal = {
        postingId: `POST-${original.contractId}-REV-${postingId}`,
        contractId: original.contractId,
        kind: "REVERSAL",
        naturalKey: `REV:${postingId}`,
        periodIndex: original.periodIndex,
        planVersion: original.planVersion,
        amountCents: -original.amountCents,
        interestCents: -original.interestCents,
        principalCents: -original.principalCents,
        postingDate,
        messageId,
        reversesPostingId: postingId,
        reason,
        approvedBy,
      };
      const postings = [reversal];
      let repostPosting = null;
      if (repost) {
        repostPosting = {
          postingId: `POST-${original.contractId}-REPOST-${postingId}`,
          contractId: original.contractId,
          kind: "REPOST",
          naturalKey: `REPOST:${postingId}`,
          periodIndex: original.periodIndex,
          planVersion: original.planVersion,
          amountCents: repost.amountCents,
          interestCents: repost.interestCents,
          principalCents: repost.principalCents,
          postingDate,
          messageId,
          reversesPostingId: postingId,
          reason,
          approvedBy,
        };
        postings.push(repostPosting);
      }
      this.store.commit({
        contractId: original.contractId,
        postings,
        event: {
          type: "POSTING_REVERSED",
          contractId: original.contractId,
          occurredAt: this.clock(),
          actor: approvedBy,
          summary: `冲正 ${postingId}：${reason}${repost ? "，并补记更正金额" : ""}`,
          refs: { postingId, reversalId: reversal.postingId, repostId: repostPosting?.postingId ?? null },
        },
      });
      return { reversal, repost: repostPosting };
    });
  }

  // ---- 勘误影响评估与更正：已入账利息以冲正+补记更正，未来期次按勘误后报价重定价 ----

  assessErrataImpact(errataId) {
    const errata = this.registry.get(errataId);
    if (!errata.corrects) throw new DomainError("NOT_AN_ERRATA", `${errataId} 不是勘误记录`);
    const impactedPostings = [];
    for (const contractId of this.store.contractIds()) {
      for (const posting of this.store.postingsFor(contractId)) {
        if (posting.kind !== "DUE_INTEREST") continue;
        if (this.#isReversed(contractId, posting.postingId)) continue;
        const plan = this.store.getPlan(contractId, posting.planVersion);
        const period = plan.periods[posting.periodIndex];
        if (period.rateFormation.publicationId !== errata.corrects) continue;
        const correctedRateBp = errata.rateBp + period.rateFormation.spreadBp;
        impactedPostings.push({
          contractId,
          postingId: posting.postingId,
          periodIndex: posting.periodIndex,
          originalInterestCents: posting.interestCents,
          correctedInterestCents: monthlyInterestCents(period.openingPrincipalCents, correctedRateBp),
        });
      }
    }
    return { errataId, corrects: errata.corrects, impactedPostings };
  }

  applyErrataCorrection({ messageId, errataId, approvedBy }) {
    return this.store.processMessage(messageId, () => {
      if (!approvedBy) throw new DomainError("VALIDATION_FAILED", "勘误更正须登记批准人");
      const impact = this.assessErrataImpact(errataId);
      const corrections = [];
      for (const item of impact.impactedPostings) {
        const original = this.store.getPosting(item.postingId);
        const delta = item.correctedInterestCents - item.originalInterestCents;
        const { result } = this.reversePosting({
          messageId: `${messageId}:${item.postingId}`,
          postingId: item.postingId,
          reason: `LPR勘误 ${errataId} 更正`,
          approvedBy,
          repost: {
            amountCents: original.amountCents + delta,
            interestCents: item.correctedInterestCents,
            principalCents: original.principalCents,
          },
        });
        corrections.push({ postingId: item.postingId, deltaCents: delta, reversalId: result.reversal.postingId });
      }
      const contractIds = new Set(impact.impactedPostings.map((item) => item.contractId));
      for (const contractId of this.store.activeContractIds()) {
        if (this.#contractUsesPublication(contractId, impact.corrects)) contractIds.add(contractId);
      }
      const repriced = [...contractIds].map((contractId) =>
        this.#repriceContract(contractId, { type: "ERRATA_CORRECTION", messageId, errataId, actor: approvedBy }, null),
      );
      return { corrections, repriced };
    });
  }

  // ---- 节假日安排更新：未入账期次的还款日按新日历顺延，生成可解释的新版本 ----

  updateCalendar({ messageId, holidays }) {
    return this.store.processMessage(messageId, () => {
      this.calendar.setHolidays(holidays);
      const results = this.store
        .activeContractIds()
        .map((contractId) => this.#repriceContract(contractId, { type: "CALENDAR_UPDATED", messageId }, null));
      return { results };
    });
  }

  // ---- 查询：客户查看利率形成，财务与审计追踪任意金额 ----

  listContracts() {
    return this.store.contractIds().map((contractId) => {
      const contract = this.store.getContract(contractId);
      const official = this.store.getOfficialPlan(contractId);
      return {
        contractId,
        borrowerRef: contract.borrowerRef,
        status: contract.status,
        principalCents: contract.principalCents,
        startDate: contract.startDate,
        termMonths: contract.termMonths,
        termsVersion: contract.terms.at(-1).version,
        officialPlanVersion: official.version,
      };
    });
  }

  officialPlanView(contractId) {
    const official = this.store.getOfficialPlan(contractId);
    const posted = this.#postedDueIndexes(contractId);
    return {
      ...official,
      status: "OFFICIAL",
      periods: official.periods.map((period) => ({ ...period, locked: posted.has(period.index) })),
    };
  }

  publicationHistory(variety) {
    return this.registry.history(variety).map((record) => ({ ...record, correctedBy: this.registry.correctedBy(record.id) }));
  }

  // 客户视角：某一期利率如何形成
  rateFormationView(contractId, periodIndex) {
    const official = this.store.getOfficialPlan(contractId);
    const period = official.periods[periodIndex];
    if (!period) throw new DomainError("PLAN_NOT_FOUND", `合同 ${contractId} 无第 ${periodIndex} 期`);
    const formation = period.rateFormation;
    const publication = this.registry.get(formation.publicationId);
    const errataId = this.registry.correctedBy(publication.id);
    const percent = (bp) => `${(bp / 100).toFixed(2)}%`;
    const spreadText = `${formation.spreadBp >= 0 ? "+" : ""}${formation.spreadBp}BP`;
    const shiftText = period.holidayShifts.length
      ? `；还款日遇${period.holidayShifts.map((shift) => shift.date).join("、")}非营业日，自 ${period.originalDueDate} 顺延至 ${period.dueDate}`
      : "";
    const narrative =
      `第 ${periodIndex + 1} 期（${period.accrualStart} 至 ${period.accrualEnd}）执行年利率 ${percent(period.rateBp)}：` +
      `重定价日 ${formation.determinationDate} 当日有效的${VARIETY_LABEL[formation.variety]}LPR 为 ${percent(formation.publicationRateBp)}` +
      `（${formation.source} ${publication.publishDate} 发布、${formation.publicationEffectiveFrom} 起生效），` +
      `叠加合同加减点 ${spreadText} 形成${shiftText}。`;
    return {
      contractId,
      planVersion: official.version,
      periodIndex,
      accrualStart: period.accrualStart,
      accrualEnd: period.accrualEnd,
      dueDate: period.dueDate,
      originalDueDate: period.originalDueDate,
      holidayShifts: period.holidayShifts,
      variety: formation.variety,
      determinationDate: formation.determinationDate,
      publicationId: formation.publicationId,
      publicationRateBp: formation.publicationRateBp,
      publicationEffectiveFrom: formation.publicationEffectiveFrom,
      publicationEffectiveTo: formation.publicationEffectiveTo,
      source: formation.source,
      spreadBp: formation.spreadBp,
      finalRateBp: period.rateBp,
      termsVersion: formation.termsVersion,
      correctedBy: errataId,
      narrative,
    };
  }

  // 财务与审计视角：从任意一笔入账追到当时有效的 LPR、合同条款与批准变更
  explainPosting(postingId) {
    const posting = this.store.getPosting(postingId);
    const plan = this.store.getPlan(posting.contractId, posting.planVersion);
    const contract = this.store.getContract(posting.contractId);
    const period = posting.periodIndex === null ? null : plan.periods[posting.periodIndex];
    const formation = period?.rateFormation ?? null;
    const publication = formation ? this.registry.get(formation.publicationId) : null;
    const errataId = publication ? this.registry.correctedBy(publication.id) : null;
    const errata = errataId ? this.registry.get(errataId) : null;
    const contractTerms = formation ? contract.terms.find((terms) => terms.version === formation.termsVersion) : null;

    const rootId = posting.reversesPostingId ?? posting.postingId;
    const chain = this.store
      .postingsFor(posting.contractId)
      .filter((item) => item.postingId === rootId || item.reversesPostingId === rootId);
    const reconciliation = {
      rootPostingId: rootId,
      chain: chain.map((item) => ({ postingId: item.postingId, kind: item.kind, interestCents: item.interestCents, amountCents: item.amountCents })),
      netInterestCents: chain.reduce((sum, item) => sum + item.interestCents, 0),
      netAmountCents: chain.reduce((sum, item) => sum + item.amountCents, 0),
    };

    const publicationIds = new Set([formation?.publicationId, errata?.id].filter(Boolean));
    const events = this.store.events.filter(
      (event) => event.contractId === posting.contractId || (event.refs?.publicationId && publicationIds.has(event.refs.publicationId)),
    );

    return {
      posting,
      planVersion: posting.planVersion,
      period,
      rateFormation: formation,
      publication,
      correctedBy: errata,
      contractTerms,
      reconciliation,
      events,
    };
  }

  // ---- 命令分发（HTTP 入口） ----

  dispatch({ messageId, type, payload }) {
    const routes = {
      PublishLpr: this.publishLpr,
      PublishErrata: this.publishErrata,
      RegisterContract: this.registerContract,
      RunBatchRepricing: this.runBatchRepricing,
      RequestRateConversion: this.requestRateConversion,
      RequestEarlyRepayment: this.requestEarlyRepayment,
      PostDueInterest: this.postDueInterest,
      ReversePosting: this.reversePosting,
      ApplyErrataCorrection: this.applyErrataCorrection,
      UpdateCalendar: this.updateCalendar,
    };
    const handler = routes[type];
    if (!handler) throw new DomainError("UNKNOWN_COMMAND", `未知命令类型：${type}`);
    return handler.call(this, { messageId, ...payload });
  }

  // ---- 内部 ----

  #assertActive(contract) {
    if (contract.status !== "ACTIVE") throw new DomainError("CONTRACT_SETTLED", `合同 ${contract.contractId} 已结清`);
  }

  #postedDueIndexes(contractId) {
    return new Set(
      this.store.postingsFor(contractId)
        .filter((posting) => posting.kind === "DUE_INTEREST")
        .map((posting) => posting.periodIndex),
    );
  }

  #lockedPeriods(contractId, plan) {
    const posted = this.#postedDueIndexes(contractId);
    return plan.periods.filter((period) => posted.has(period.index));
  }

  #assertUnlockedBoundary(contractId, plan, date) {
    const posted = this.#postedDueIndexes(contractId);
    const candidates = plan.periods.filter((period) => !posted.has(period.index)).map((period) => period.accrualStart);
    if (!candidates.includes(date)) {
      throw new DomainError("INVALID_EFFECTIVE_DATE", `生效日 ${date} 须为未入账期次的起始日`);
    }
  }

  #isReversed(contractId, postingId) {
    return this.store
      .postingsFor(contractId)
      .some((posting) => posting.kind === "REVERSAL" && posting.reversesPostingId === postingId);
  }

  #contractUsesPublication(contractId, publicationId) {
    const official = this.store.getOfficialPlan(contractId);
    const posted = this.#postedDueIndexes(contractId);
    return official.periods.some(
      (period) => !posted.has(period.index) && period.rateFormation.publicationId === publicationId,
    );
  }
}
