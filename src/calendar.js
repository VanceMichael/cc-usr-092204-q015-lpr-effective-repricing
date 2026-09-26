import { addDays, dayOfWeek } from "./dates.js";

// 营业日历：周末与公布的节假日为非营业日。
// 节假日顺延只移动还款日，不移动合同重定价日；每次顺延都保留逐日轨迹以便解释。
export class BusinessCalendar {
  constructor(holidays = []) {
    this.holidays = new Set(holidays);
  }

  setHolidays(holidays) {
    this.holidays = new Set(holidays);
  }

  isHoliday(iso) {
    return this.holidays.has(iso);
  }

  isBusinessDay(iso) {
    const week = dayOfWeek(iso);
    return week !== 0 && week !== 6 && !this.isHoliday(iso);
  }

  // 顺延到下一营业日，返回调整后日期与被跳过的每一日及原因。
  adjust(iso) {
    const shifts = [];
    let current = iso;
    while (!this.isBusinessDay(current)) {
      shifts.push({ date: current, reason: this.isHoliday(current) ? "HOLIDAY" : "WEEKEND" });
      current = addDays(current, 1);
    }
    return { date: current, shifts };
  }
}
