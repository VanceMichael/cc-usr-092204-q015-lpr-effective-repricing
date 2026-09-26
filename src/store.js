import { DomainError, VersionConflict } from "./errors.js";

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// 账务存储：所有状态变更都经 commit 单点提交，先校验后生效，保证原子性。
// 核心不变量：
//   - 一个合同同一时刻只有一条正式计划（official 指针唯一，版本线性递增）；
//   - 入账记录按自然键唯一，写入即冻结，永不改写；
//   - 消息按 messageId 去重，重复投递返回首次结果，不产生副作用。
export class Store {
  #contracts = new Map();
  #plans = new Map(); // contractId -> 全部计划版本（追加）
  #official = new Map(); // contractId -> 当前正式计划
  #postings = new Map(); // postingId -> 入账记录
  #postingKeys = new Set(); // contractId|naturalKey
  #inbox = new Map(); // messageId -> 首次处理结果
  #events = [];
  #eventSeq = 0;

  // ---- 幂等收件箱 ----
  processMessage(messageId, handler) {
    if (!messageId) throw new DomainError("MESSAGE_ID_REQUIRED", "消息标识必填");
    if (this.#inbox.has(messageId)) {
      return { replayed: true, result: this.#inbox.get(messageId).result };
    }
    const result = handler();
    this.#inbox.set(messageId, deepFreeze({ messageId, result }));
    return { replayed: false, result };
  }

  appendEvent(event) {
    const record = deepFreeze({ id: `EVT-${++this.#eventSeq}`, ...event });
    this.#events.push(record);
    return record;
  }

  get events() {
    return [...this.#events];
  }

  eventsFor(contractId) {
    return this.#events.filter((event) => event.contractId === contractId);
  }

  // ---- 单点提交：全部校验通过后一次性生效 ----
  commit({ contractId, expectedPlanVersion = null, newPlan = null, newContract = null, expectedTermsVersion = null, postings = [], event = null }) {
    const currentContract = this.#contracts.get(contractId) ?? null;
    const currentOfficial = this.#official.get(contractId) ?? null;

    if (!currentContract && !newContract) {
      throw new DomainError("CONTRACT_NOT_FOUND", `合同不存在：${contractId}`);
    }
    if (newPlan) {
      const expected = expectedPlanVersion ?? 0;
      const actual = currentOfficial ? currentOfficial.version : 0;
      if (actual !== expected) {
        throw new VersionConflict(`合同 ${contractId} 正式计划版本已变为 ${actual}，本次基于 ${expected} 提交`);
      }
      if (newPlan.version !== expected + 1) {
        throw new DomainError("PLAN_VERSION_GAP", `计划版本须线性递增：期望 ${expected + 1}，收到 ${newPlan.version}`);
      }
    }
    if (newContract && currentContract) {
      const actual = currentContract.terms.at(-1).version;
      if (expectedTermsVersion === null || actual !== expectedTermsVersion) {
        throw new VersionConflict(`合同 ${contractId} 条款版本已变为 ${actual}，本次基于 ${expectedTermsVersion} 提交`);
      }
    }
    for (const posting of postings) {
      const key = `${contractId}|${posting.naturalKey}`;
      if (this.#postingKeys.has(key)) throw new DomainError("DUPLICATE_POSTING", `入账重复：${key}`);
      if (this.#postings.has(posting.postingId)) throw new DomainError("DUPLICATE_POSTING", `入账标识重复：${posting.postingId}`);
    }

    if (newContract) this.#contracts.set(contractId, deepFreeze(newContract));
    if (newPlan) {
      if (!this.#plans.has(contractId)) this.#plans.set(contractId, []);
      this.#plans.get(contractId).push(deepFreeze(newPlan));
      this.#official.set(contractId, newPlan);
    }
    for (const posting of postings) {
      this.#postings.set(posting.postingId, deepFreeze(posting));
      this.#postingKeys.add(`${contractId}|${posting.naturalKey}`);
    }
    if (event) this.appendEvent(event);
  }

  // ---- 查询 ----
  hasContract(contractId) {
    return this.#contracts.has(contractId);
  }

  getContract(contractId) {
    const contract = this.#contracts.get(contractId);
    if (!contract) throw new DomainError("CONTRACT_NOT_FOUND", `合同不存在：${contractId}`);
    return contract;
  }

  contractIds() {
    return [...this.#contracts.keys()];
  }

  activeContractIds() {
    return this.contractIds().filter((id) => this.#contracts.get(id).status === "ACTIVE");
  }

  getOfficialPlan(contractId) {
    const plan = this.#official.get(contractId);
    if (!plan) throw new DomainError("PLAN_NOT_FOUND", `合同 ${contractId} 无正式计划`);
    return plan;
  }

  getPlan(contractId, version) {
    const plan = (this.#plans.get(contractId) ?? []).find((item) => item.version === version);
    if (!plan) throw new DomainError("PLAN_NOT_FOUND", `合同 ${contractId} 无计划版本 ${version}`);
    return plan;
  }

  planHistory(contractId) {
    return [...(this.#plans.get(contractId) ?? [])];
  }

  getPosting(postingId) {
    const posting = this.#postings.get(postingId);
    if (!posting) throw new DomainError("POSTING_NOT_FOUND", `入账记录不存在：${postingId}`);
    return posting;
  }

  postingsFor(contractId) {
    return [...this.#postings.values()].filter((posting) => posting.contractId === contractId);
  }
}
