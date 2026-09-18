'use strict';
/* ==========================================================================
 * 农历 / 二十四节气计算（window.NPLunar）
 * 农历数据表来自开源项目 solarlunar（ISC License，https://github.com/yize/solarlunar），
 * 算法为公版通行实现，覆盖 1900-2100 年。
 * ========================================================================== */

(() => {
  // 农历 1900-2100 年闰月与大小月信息表
  const lunarInfo = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
    0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252, // 2090-2099
    0x0d520, // 2100
  ];

  // 二十四节气名称（每年 1-12 月，每月节气 + 中气）
  const termNames = [
    '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
    '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
    '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
  ];

  const monthNames = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  const dayNames = [
    '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
  ];
  const gan = '甲乙丙丁戊己庚辛壬癸';
  const zhi = '子丑寅卯辰巳午未申酉戌亥';
  const animals = '鼠牛虎兔龙蛇马羊猴鸡狗猪';

  /* -------------------- 基础换算 -------------------- */

  function leapMonth(y) { return lunarInfo[y - 1900] & 0xf; }
  function leapDays(y) { return leapMonth(y) ? ((lunarInfo[y - 1900] & 0x10000) ? 30 : 29) : 0; }
  function lYearDays(y) {
    let sum = 348;
    for (let i = 0x8000; i > 0x8; i >>= 1) sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
    return sum + leapDays(y);
  }
  function monthDays(y, m) { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

  // 节气 n（0-23）在 y 年的公历日：天文算法（shouxing-core.js）
  // 目标黄经 = 285°+15°n（小寒 285° … 冬至 270°）；J2000 时刻太阳黄经约 280°，
  // 黄经 <280° 的节气（春分~大雪）解落在 (y-1999) 圈，≥285° 的（小寒~惊蛰）落在 (y-2000) 圈
  function termDay(y, n) {
    const lambda = (285 + 15 * n) % 360;
    const cycles = (y - 2000) + (lambda < 280 ? 1 : 0);
    const days = window.NPShouXing.qiAccurate(lambda * Math.PI / 180 + cycles * Math.PI * 2);
    return new Date(Date.UTC(2000, 0, 1, 12) + Math.round(days * 86400000)).getUTCDate();
  }
  function termOf(y, m, d) {
    if (y < 1901 || y > 2100) return '';
    const a = (m - 1) * 2;
    if (termDay(y, a) === d) return termNames[a];
    if (termDay(y, a + 1) === d) return termNames[a + 1];
    return '';
  }

  /** 公历 → 农历：{ly, lm, ld, isLeap, monthName, dayName, gzYear, animal}；超范围返回 null */
  function solar2lunar(y, m, d) {
    if (y < 1901 || y > 2100) return null;
    let offset = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
    let i, temp = 0;
    for (i = 1900; i <= 2100 && offset > 0; i++) { temp = lYearDays(i); offset -= temp; }
    if (offset < 0) { offset += temp; i--; }
    const ly = i;
    const leap = leapMonth(ly);
    let isLeap = false;
    let j;
    for (j = 1; j < 13 && offset > 0; j++) {
      if (leap > 0 && j === leap + 1 && isLeap === false) { --j; isLeap = true; temp = leapDays(ly); }
      else { temp = monthDays(ly, j); }
      if (isLeap === true && j === leap + 1) isLeap = false;
      offset -= temp;
    }
    if (offset === 0 && leap > 0 && j === leap + 1) {
      if (isLeap) isLeap = false;
      else { isLeap = true; --j; }
    } else if (offset < 0) { offset += temp; --j; }
    const ld = offset + 1;
    const gz = (ly - 4) % 10, zz = (ly - 4) % 12;
    return {
      ly, lm: j, ld, isLeap,
      monthName: (isLeap ? '闰' : '') + monthNames[j - 1] + '月',
      dayName: dayNames[ld - 1],
      gzYear: gan[gz] + zhi[zz],
      animal: animals[zz],
    };
  }

  /* -------------------- 农历传统节日 -------------------- */

  function festivalOf(L) {
    if (L.isLeap) return '';
    if (L.lm === 1 && L.ld === 1) return '春节';
    if (L.lm === 1 && L.ld === 15) return '元宵节';
    if (L.lm === 2 && L.ld === 2) return '龙抬头';
    if (L.lm === 5 && L.ld === 5) return '端午节';
    if (L.lm === 7 && L.ld === 7) return '七夕';
    if (L.lm === 8 && L.ld === 15) return '中秋节';
    if (L.lm === 9 && L.ld === 9) return '重阳节';
    if (L.lm === 12 && L.ld === 8) return '腊八节';
    if (L.lm === 12 && L.ld === 30) return '除夕';
    if (L.lm === 12 && L.ld === 29 && monthDays(L.ly, 12) === 29) return '除夕';
    return '';
  }

  /**
   * 日历展示标签（优先级：农历节日 > 节气 > 农历）
   * 返回 {text, kind}；kind: 'festival' | 'term' | 'lunar' | 'lunar-month' | null
   */
  function label(y, m, d) {
    const L = solar2lunar(y, m, d);
    if (!L) return null;
    const fest = festivalOf(L);
    if (fest) return { text: fest, kind: 'festival' };
    const term = termOf(y, m, d);
    if (term) return { text: term, kind: 'term' };
    if (L.ld === 1) return { text: L.monthName, kind: 'lunar-month' };
    return { text: L.dayName, kind: 'lunar' };
  }

  /** 完整农历描述：'农历甲辰龙年八月十五' */
  function fullText(y, m, d) {
    const L = solar2lunar(y, m, d);
    if (!L) return '';
    return `农历${L.gzYear}${L.animal}年${L.monthName}${L.dayName}`;
  }

  window.NPLunar = { solar2lunar, label, fullText, termOf, festivalOf, termDay };
})();
