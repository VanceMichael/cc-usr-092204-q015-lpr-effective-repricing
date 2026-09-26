import { addMonths, compareDates } from "./dates.js";
import { DomainError } from "./errors.js";
import { termsOn } from "./contract.js";
import { annuityPaymentCents, monthlyInterestCents } from "./money.js";

// 还款计划生成：纯函数，同样的输入永远得到同样的期次数值。
// 已入账期次由调用方作为 preservePeriods 原样传入，本函数绝不重算。
// 每个期次都携带利率形成快照（引用哪条报价、哪个条款版本、加减点），供客户与审计逐期核对。

// 合同重定价日：按条款版本的规则从放款日推导，不随还款日顺延而移动。
function scheduleDates(startDate, terms, spanStart, spanEnd) {
  const dates = [];
  if (terms.repricingRule === "ANNIVERSARY") {
    for (let k = 1; ; k += 1) {
      const date = addMonths(startDate, k * terms.repricingFrequencyMonths);
      if (compareDates(date, spanStart) < 0) continue;
      if (compareDates(date, spanEnd) >= 0) break;
      dates.push(date);
    }
  } else {
    // YEAR_START：每年1月1日
    for (let year = Number(startDate.slice(0, 4)) + 1; ; year += 1) {
      const date = `${year}-01-01`;
      if (compareDates(date, spanStart) < 0) continue;
      if (compareDates(date, spanEnd) >= 0) break;
      dates.push(date);
    }
  }
  return dates;
}

// 利率区间边界：放款日、各条款版本生效日、各条款版本管辖区间内的重定价日。
// 一律从放款日的合同日程推导：续算（重定价/提前还款）只从某个期次边界继续生成，
// 其所在区间的重定价日仍是合同约定日，绝不因续算起点而移动。
function epochBoundaries(contract, to) {
  const from = contract.startDate;
  const boundaries = new Set([from]);
  for (let index = 0; index < contract.terms.length; index += 1) {
    const terms = contract.terms[index];
    const spanEnd = index + 1 < contract.terms.length ? contract.terms[index + 1].effectiveFrom : to;
    if (compareDates(terms.effectiveFrom, from) > 0 && compareDates(terms.effectiveFrom, to) < 0) {
      boundaries.add(terms.effectiveFrom);
    }
    for (const date of scheduleDates(contract.startDate, terms, terms.effectiveFrom, spanEnd)) {
      if (compareDates(date, from) > 0 && compareDates(date, to) < 0) boundaries.add(date);
    }
  }
  return [...boundaries].sort(compareDates);
}

/**
 * 生成还款计划版本。
 * @param preservePeriods 已入账等需原样保留的期次（前缀）
 * @param openingBalanceCents 续算起点本金（提前还款后小于保留期次期末余额）
 * @param remainingMonths 续算期数
 */
export function buildPlan({ contract, registry, calendar, version, cause, asOf, preservePeriods = [], openingBalanceCents = null, remainingMonths = null }) {
  const anchor = preservePeriods.length ? preservePeriods.at(-1).accrualEnd : contract.startDate;
  let balance = openingBalanceCents ?? (preservePeriods.length ? preservePeriods.at(-1).closingPrincipalCents : contract.principalCents);
  const total = remainingMonths ?? contract.termMonths - preservePeriods.length;

  const periods = [...preservePeriods];
  if (total > 0) {
    const endDate = addMonths(anchor, total);
    const epochs = epochBoundaries(contract, endDate).map((date) => {
      const terms = termsOn(contract, date);
      const publication = registry.lprOn(terms.variety, date);
      const rateBp = publication.rateBp + terms.spreadBp;
      if (rateBp <= 0) throw new DomainError("NON_POSITIVE_RATE", `${date} 形成的执行利率须为正：${rateBp}BP`);
      return { date, terms, publication, rateBp };
    });
    const epochOn = (date) => {
      let hit = epochs[0];
      for (const epoch of epochs) {
        if (compareDates(epoch.date, date) <= 0) hit = epoch;
      }
      return hit;
    };

    let payment = null;
    let currentEpoch = null;
    for (let index = 0; index < total; index += 1) {
      const accrualStart = index === 0 ? anchor : addMonths(anchor, index);
      const accrualEnd = addMonths(anchor, index + 1);
      const epoch = epochOn(accrualStart);
      if (epoch !== currentEpoch) {
        // 进入新利率区间：按剩余本金与剩余期数重新计算月供
        currentEpoch = epoch;
        payment = annuityPaymentCents(balance, epoch.rateBp, total - index);
      }
      const interest = monthlyInterestCents(balance, epoch.rateBp);
      let principal = payment - interest;
      let closing = balance - principal;
      if (index === total - 1 || closing < 0) {
        // 末期结清尾差
        principal = balance;
        closing = 0;
        payment = principal + interest;
      }
      const adjusted = calendar.adjust(accrualEnd);
      const { terms, publication } = epoch;
      periods.push(
        Object.freeze({
          index: preservePeriods.length + index,
          accrualStart,
          accrualEnd,
          dueDate: adjusted.date,
          originalDueDate: accrualEnd,
          holidayShifts: Object.freeze(adjusted.shifts),
          rateBp: epoch.rateBp,
          rateFormation: Object.freeze({
            variety: terms.variety,
            determinationDate: epoch.date,
            publicationId: publication.id,
            publicationRateBp: publication.rateBp,
            publicationEffectiveFrom: publication.effectiveFrom,
            publicationEffectiveTo: publication.effectiveTo,
            source: publication.source,
            spreadBp: terms.spreadBp,
            termsVersion: terms.version,
          }),
          openingPrincipalCents: balance,
          paymentCents: payment,
          interestCents: interest,
          principalCents: principal,
          closingPrincipalCents: closing,
        }),
      );
      balance = closing;
    }
  }

  return Object.freeze({
    planId: `${contract.contractId}-PLAN-V${version}`,
    contractId: contract.contractId,
    version,
    cause: Object.freeze({ ...cause }),
    createdAt: asOf,
    periods: Object.freeze(periods),
  });
}

// 计划内容指纹：仅期次数值参与比较，版本号、事由、生成时间不影响“是否变化”的判定。
export function planFingerprint(plan) {
  return JSON.stringify(plan.periods);
}
