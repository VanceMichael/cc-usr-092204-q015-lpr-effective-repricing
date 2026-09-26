import { readFile } from "node:fs/promises";
import { BusinessCalendar } from "./calendar.js";
import { LprRegistry } from "./publications.js";
import { BankService } from "./service.js";
import { Store } from "./store.js";

export async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

// 用 fixtures 中的去标识样例装配一套可运行的服务：报价登记、营业日历、合同样例。
export async function bootstrap({ clock } = {}) {
  const [publications, holidays, contracts] = await Promise.all([
    loadFixture("lpr-publications.json"),
    loadFixture("holidays.json"),
    loadFixture("contracts.json"),
  ]);
  const registry = new LprRegistry();
  const calendar = new BusinessCalendar(holidays.holidays);
  const store = new Store();
  const service = new BankService({ registry, calendar, store, clock });

  const ordered = [...publications.publications].sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom ? a.variety.localeCompare(b.variety) : a.effectiveFrom < b.effectiveFrom ? -1 : 1,
  );
  for (const publication of ordered) {
    await service.publishLpr({ messageId: `SEED-${publication.id}`, ...publication });
  }
  for (const contract of contracts.contracts) {
    await service.registerContract({ messageId: `SEED-${contract.contractId}`, ...contract });
  }
  return { service, store, registry, calendar };
}
