import { LprRegistry } from "../src/publications.js";
import { BusinessCalendar } from "../src/calendar.js";
import { Store } from "../src/store.js";
import { BankService } from "../src/service.js";

export const FIXED_NOW = "2026-01-05T09:00:00.000Z";

export function defaultPublications() {
  const source = "全国银行间同业拆借中心";
  return [
    { id: "P1-20241220", variety: "1Y", rateBp: 310, publishDate: "2024-12-20", effectiveFrom: "2024-12-20", source, approvedBy: "运营方" },
    { id: "P5-20241220", variety: "5Y_PLUS", rateBp: 360, publishDate: "2024-12-20", effectiveFrom: "2024-12-20", source, approvedBy: "运营方" },
    { id: "P1-20250520", variety: "1Y", rateBp: 300, publishDate: "2025-05-20", effectiveFrom: "2025-05-20", source, approvedBy: "运营方" },
    { id: "P5-20250520", variety: "5Y_PLUS", rateBp: 350, publishDate: "2025-05-20", effectiveFrom: "2025-05-20", source, approvedBy: "运营方" },
  ];
}

export function makeService({ holidays = [], publications = defaultPublications(), clock } = {}) {
  const registry = new LprRegistry();
  for (const publication of publications) registry.publish(publication);
  const calendar = new BusinessCalendar(holidays);
  const store = new Store();
  const service = new BankService({ registry, calendar, store, clock: clock ?? (() => FIXED_NOW) });
  return { service, store, registry, calendar };
}

export function sampleContract(overrides = {}) {
  return {
    contractId: "LN-T-0001",
    borrowerRef: "测试客户（去标识）",
    principalCents: 100000000,
    startDate: "2025-01-15",
    termMonths: 360,
    terms: {
      variety: "5Y_PLUS",
      spreadBp: -20,
      repricingFrequencyMonths: 12,
      repricingRule: "ANNIVERSARY",
      effectiveFrom: "2025-01-15",
      reason: "放款",
      approvedBy: "审批岗A",
    },
    ...overrides,
  };
}

// 登记样例合同并返回首个正式计划
export function registerSample(service, overrides = {}) {
  const contract = sampleContract(overrides);
  service.registerContract({ messageId: `M-REG-${contract.contractId}`, ...contract });
  return contract;
}
