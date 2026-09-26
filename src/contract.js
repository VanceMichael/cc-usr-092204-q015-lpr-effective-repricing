import { compareDates, parseDate } from "./dates.js";
import { DomainError } from "./errors.js";
import { VARIETIES } from "./publications.js";

export const REPRICING_RULES = ["ANNIVERSARY", "YEAR_START"];

function assertTerms(terms) {
  if (!VARIETIES.includes(terms.variety)) throw new DomainError("VALIDATION_FAILED", `未知期限品种：${terms.variety}`);
  if (!Number.isInteger(terms.spreadBp)) throw new DomainError("VALIDATION_FAILED", "加减点须为整数基点");
  if (!Number.isInteger(terms.repricingFrequencyMonths) || terms.repricingFrequencyMonths < 1 || terms.repricingFrequencyMonths > 36) {
    throw new DomainError("VALIDATION_FAILED", "重定价频率须为 1-36 个月");
  }
  if (!REPRICING_RULES.includes(terms.repricingRule)) throw new DomainError("VALIDATION_FAILED", `未知重定价规则：${terms.repricingRule}`);
  if (terms.repricingRule === "YEAR_START" && terms.repricingFrequencyMonths !== 12) {
    throw new DomainError("VALIDATION_FAILED", "每年1月1日重定价要求频率为12个月");
  }
  parseDate(terms.effectiveFrom);
  if (!terms.reason) throw new DomainError("VALIDATION_FAILED", "条款事由必填");
  if (!terms.approvedBy) throw new DomainError("VALIDATION_FAILED", "条款批准人必填");
}

// 贷款合同：基准信息（本金、放款日、期限）冻结保存；
// 合同基准、加减点、重定价频率等条款以版本链追加，利率转换产生新版本，历史版本永不改写。
export function createContract({ contractId, borrowerRef, principalCents, startDate, termMonths, terms }) {
  if (!contractId) throw new DomainError("VALIDATION_FAILED", "合同号必填");
  if (!borrowerRef) throw new DomainError("VALIDATION_FAILED", "客户引用必填");
  if (!Number.isInteger(principalCents) || principalCents <= 0) throw new DomainError("VALIDATION_FAILED", "本金须为正整数分");
  if (!Number.isInteger(termMonths) || termMonths <= 0) throw new DomainError("VALIDATION_FAILED", "期限须为正整数月");
  parseDate(startDate);
  assertTerms(terms);
  return Object.freeze({
    contractId,
    borrowerRef,
    principalCents,
    startDate,
    termMonths,
    repaymentMethod: "EQUAL_INSTALLMENT",
    status: "ACTIVE",
    terms: Object.freeze([Object.freeze({ ...terms, version: 1 })]),
  });
}

// 条款变更（利率转换）：返回追加新版本后的合同对象，原对象不变。
export function reviseTerms(contract, change) {
  const current = contract.terms.at(-1);
  const next = {
    variety: change.variety ?? current.variety,
    spreadBp: change.spreadBp ?? current.spreadBp,
    repricingFrequencyMonths: change.repricingFrequencyMonths ?? current.repricingFrequencyMonths,
    repricingRule: change.repricingRule ?? current.repricingRule,
    effectiveFrom: change.effectiveFrom,
    reason: change.reason,
    approvedBy: change.approvedBy,
  };
  assertTerms(next);
  if (compareDates(next.effectiveFrom, current.effectiveFrom) < 0) {
    throw new DomainError("TERMS_RETROACTIVE", "条款变更生效日不得早于当前生效版本");
  }
  return Object.freeze({
    ...contract,
    terms: Object.freeze([...contract.terms, Object.freeze({ ...next, version: current.version + 1 })]),
  });
}

// 某日期实际适用的条款版本。
export function termsOn(contract, date) {
  let hit = contract.terms[0];
  for (const terms of contract.terms) {
    if (compareDates(terms.effectiveFrom, date) <= 0) hit = terms;
  }
  return hit;
}
