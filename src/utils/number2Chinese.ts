// 数字转中文大写工具函数
export default (num: number) => {
  const chineseNumbers = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const units = ["", "十", "百", "千"];
  const bigUnits = ["", "万", "亿"];

  if (num === 0) return chineseNumbers[0];

  let result = "";
  let unitIndex = 0;
  let needZero = false;

  while (num > 0) {
    const digit = num % 10;

    if (digit === 0) {
      if (!needZero && result && unitIndex % 4 !== 0) {
        needZero = true;
      }
    } else {
      if (needZero) {
        result = chineseNumbers[0] + result;
        needZero = false;
      }
      result = chineseNumbers[digit] + (unitIndex % 4 === 0 ? "" : units[unitIndex % 4] || "") + result;
    }

    if (unitIndex % 4 === 0 && unitIndex > 0 && result) {
      result = bigUnits[Math.floor(unitIndex / 4)] + result;
    }

    num = Math.floor(num / 10);
    unitIndex++;
  }

  // 处理特殊情况：10-19的简化（十一、十二 而不是 一十一、一十二）
  if (result.startsWith("一十")) {
    result = result.substring(1);
  }

  return result;
};
