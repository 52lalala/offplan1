const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function getWeekStart(input = new Date()) {
  const date = new Date(input);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + diff);
  return date;
}

export function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

export function parseDateKey(dateString: string) {
  return new Date(`${dateString}T00:00:00`);
}

export function formatMonthDay(dateString: string) {
  const date = parseDateKey(dateString);
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

export function getWeekdayLabel(dateString: string) {
  const date = parseDateKey(dateString);
  return WEEKDAY_LABELS[date.getDay()];
}

export function formatDisplayDate(dateString: string) {
  return `${formatMonthDay(dateString)} ${getWeekdayLabel(dateString)}`;
}

export function formatWeekRange(startDate: string, endDate: string) {
  return `${formatMonthDay(startDate)} 至 ${formatMonthDay(endDate)}`;
}

export function buildDaysFromRange(startDate: string, endDate: string) {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  const days = [];

  for (let current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    const key = formatDateKey(current);
    days.push({
      key,
      label: formatDisplayDate(key),
      shortDate: formatMonthDay(key),
      weekdayLabel: getWeekdayLabel(key),
      weekday: current.getDay(),
      isWeekend: current.getDay() === 0 || current.getDay() === 6,
    });
  }

  return days;
}
