import { addDays, compareDates, parseDate } from "./dates.js";
import { DomainError } from "./errors.js";

// 期限品种：一年期 / 五年期以上。
export const VARIETIES = ["1Y", "5Y_PLUS"];

// LPR 报价登记：保存授权发布来源、期限品种、发布日期与有效起止。
// 引用一律按有效区间判定，发布日期只是档案信息——两者不得混用。
// 记录的利率、发布日期一经写入永不改写；仅允许两类追加式更新：
//   1. 下一期报价生效时闭合本期有效区间（当前数值在下一次发布前有效）；
//   2. 勘误登记（原记录保留，通过 correctedBy 链指向勘误记录）。
export class LprRegistry {
  #records = new Map();
  #byVariety = new Map(VARIETIES.map((variety) => [variety, []]));
  #correctedBy = new Map(); // 被勘误记录 id -> 勘误记录 id

  publish({ id, variety, rateBp, publishDate, effectiveFrom, source, approvedBy, note = null }) {
    if (this.#records.has(id)) throw new DomainError("DUPLICATE_PUBLICATION", `报价已存在：${id}`);
    if (!VARIETIES.includes(variety)) throw new DomainError("VALIDATION_FAILED", `未知期限品种：${variety}`);
    if (!Number.isInteger(rateBp) || rateBp <= 0) throw new DomainError("VALIDATION_FAILED", "报价利率须为正整数基点");
    parseDate(publishDate);
    parseDate(effectiveFrom);
    if (compareDates(effectiveFrom, publishDate) < 0) {
      throw new DomainError("VALIDATION_FAILED", "生效日期不得早于发布日期");
    }
    if (!source) throw new DomainError("VALIDATION_FAILED", "授权发布来源必填");

    const list = this.#byVariety.get(variety);
    const prev = list.at(-1);
    if (prev) {
      if (compareDates(effectiveFrom, prev.effectiveFrom) <= 0) {
        throw new DomainError("WINDOW_OVERLAP", `生效窗口与 ${prev.id} 重叠`);
      }
      if (prev.effectiveTo === null) {
        prev.effectiveTo = addDays(effectiveFrom, -1);
        const errataId = this.#correctedBy.get(prev.id);
        if (errataId) this.#records.get(errataId).effectiveTo = prev.effectiveTo;
      }
    }

    const record = { id, variety, rateBp, publishDate, effectiveFrom, effectiveTo: null, source, approvedBy, note, corrects: null };
    this.#records.set(id, record);
    list.push(record);
    return record;
  }

  // 勘误：更正记录继承原报价的有效区间，原记录保留可查。
  publishErrata({ id, corrects, rateBp, reason, approvedBy, publishDate }) {
    if (this.#records.has(id)) throw new DomainError("DUPLICATE_PUBLICATION", `报价已存在：${id}`);
    const original = this.#records.get(corrects);
    if (!original) throw new DomainError("PUBLICATION_NOT_FOUND", `勘误对象不存在：${corrects}`);
    if (this.#correctedBy.has(corrects)) throw new DomainError("DUPLICATE_ERRATA", `报价 ${corrects} 已被勘误`);
    if (!Number.isInteger(rateBp) || rateBp <= 0) throw new DomainError("VALIDATION_FAILED", "报价利率须为正整数基点");
    if (!reason) throw new DomainError("VALIDATION_FAILED", "勘误原因必填");

    const record = {
      id,
      variety: original.variety,
      rateBp,
      publishDate: publishDate ?? original.publishDate,
      effectiveFrom: original.effectiveFrom,
      effectiveTo: original.effectiveTo,
      source: original.source,
      approvedBy,
      note: reason,
      corrects,
    };
    this.#records.set(id, record);
    this.#correctedBy.set(corrects, id);
    return record;
  }

  // 某日期实际有效的报价：按有效区间命中；若该记录已被勘误，返回勘误后的数值。
  lprOn(variety, date) {
    const list = this.#byVariety.get(variety) ?? [];
    const found = list.find(
      (record) =>
        compareDates(record.effectiveFrom, date) <= 0 &&
        (record.effectiveTo === null || compareDates(date, record.effectiveTo) <= 0),
    );
    if (!found) throw new DomainError("NO_EFFECTIVE_LPR", `${date} 无有效的 ${variety} LPR`);
    const errataId = this.#correctedBy.get(found.id);
    return errataId ? this.#records.get(errataId) : found;
  }

  get(id) {
    const record = this.#records.get(id);
    if (!record) throw new DomainError("PUBLICATION_NOT_FOUND", `报价不存在：${id}`);
    return record;
  }

  correctedBy(id) {
    return this.#correctedBy.get(id) ?? null;
  }

  history(variety) {
    return [...(this.#byVariety.get(variety) ?? [])];
  }
}
