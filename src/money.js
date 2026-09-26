// 金额以“分”（整数）保存，利率以“基点”（万分之一，整数）保存，浮点误差不得进入账务。
// 等额本息按月计息：月利率 = 年利率 / 12；每期利息四舍五入到分，末期调整尾差。

export function monthlyInterestCents(principalCents, annualRateBp) {
  return Math.round((principalCents * annualRateBp) / 120000);
}

export function annuityPaymentCents(principalCents, annualRateBp, months) {
  if (months <= 0) return principalCents;
  const monthlyRate = annualRateBp / 120000;
  if (monthlyRate === 0) return Math.round(principalCents / months);
  const factor = (1 + monthlyRate) ** months;
  return Math.round((principalCents * monthlyRate * factor) / (factor - 1));
}
