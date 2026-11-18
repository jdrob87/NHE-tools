// Shared dashboard view helpers. Safe in the browser and in Node tests.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NheView = api;
})(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WINDOW_DAYS = 14;

  function parseYmd(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  function formatYmd(date) {
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return date.getUTCFullYear() + '-' + month + '-' + day;
  }

  function addUtcDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
  }

  function windowSpan(today) {
    const start = parseYmd(today);
    if (!start) return null;
    return { start: start, end: addUtcDays(start, WINDOW_DAYS - 1) };
  }

  function inWindow(ymd, today) {
    const day = parseYmd(ymd);
    const span = windowSpan(today);
    if (!day || !span) return false;
    return day.getTime() >= span.start.getTime() && day.getTime() <= span.end.getTime();
  }

  function filterEvents(events, today, lane) {
    const list = Array.isArray(events) ? events : [];
    return list.filter(function (event) {
      if (!event || !inWindow(event.date, today)) return false;
      if (lane === 'work' || lane === 'family') return event.lane === lane;
      return true;
    }).sort(function (a, b) {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  function eventsForLane(events, lane) {
    const list = Array.isArray(events) ? events : [];
    if (lane === 'work' || lane === 'family') {
      return list.filter(function (event) { return event && event.lane === lane; });
    }
    return list.slice();
  }

  function filterBots(bots, mode) {
    const list = Array.isArray(bots) ? bots : [];
    if (mode === 'you') return list.filter(function (bot) { return bot && bot.state === 'you'; });
    if (mode === 'active') return list.filter(function (bot) { return bot && bot.state === 'active'; });
    return list.slice();
  }

  function monthLabel(month) {
    const year = month.slice(0, 4);
    const index = Number(month.slice(5, 7)) - 1;
    if (index < 0 || index > 11) return month;
    return MONTHS[index] + ' ' + year;
  }

  function buildMonth(month, today, events) {
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return { month: month || '', label: '', cells: [] };
    }
    const year = Number(month.slice(0, 4));
    const index = Number(month.slice(5, 7)) - 1;
    if (index < 0 || index > 11) return { month: month, label: month, cells: [] };
    const first = new Date(Date.UTC(year, index, 1));
    const daysInMonth = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
    const eventDays = {};
    (events || []).forEach(function (event) {
      if (event && typeof event.date === 'string' && event.date.slice(0, 7) === month) eventDays[event.date] = true;
    });
    const cells = [];
    for (let pad = 0; pad < first.getUTCDay(); pad++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = formatYmd(new Date(Date.UTC(year, index, day)));
      cells.push({
        date: date,
        day: day,
        isToday: date === today,
        hasEvent: !!eventDays[date],
      });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return { month: month, label: monthLabel(month), cells: cells };
  }

  function monthsForWindow(calendarMonth, today) {
    const months = [];
    function add(month) {
      if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && months.indexOf(month) === -1) {
        const index = Number(month.slice(5, 7));
        if (index >= 1 && index <= 12) months.push(month);
      }
    }
    add(calendarMonth);
    const span = windowSpan(today);
    if (span) {
      add(formatYmd(span.start).slice(0, 7));
      add(formatYmd(span.end).slice(0, 7));
    }
    return months;
  }

  function formatStamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    let hours = date.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const mins = String(date.getMinutes()).padStart(2, '0');
    return MONTHS_SHORT[date.getMonth()] + ' ' + date.getDate() + ', ' + hours + ':' + mins + ' ' + ampm;
  }

  function botPill(state) {
    if (state === 'you') return { label: 'Waiting on you', tone: 'warning' };
    if (state === 'active') return { label: 'Active', tone: 'done' };
    return { label: 'On hold', tone: 'neutral' };
  }

  function sortActivity(items) {
    return (Array.isArray(items) ? items : []).slice().sort(function (a, b) {
      return Date.parse(b.at) - Date.parse(a.at);
    });
  }

  return {
    WINDOW_DAYS: WINDOW_DAYS,
    parseYmd: parseYmd,
    formatYmd: formatYmd,
    inWindow: inWindow,
    filterEvents: filterEvents,
    eventsForLane: eventsForLane,
    filterBots: filterBots,
    buildMonth: buildMonth,
    monthsForWindow: monthsForWindow,
    formatStamp: formatStamp,
    botPill: botPill,
    sortActivity: sortActivity,
  };
});
