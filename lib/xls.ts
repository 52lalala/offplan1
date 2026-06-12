import * as XLSX from "xlsx";
import type { XlsData, XlsSlotDef, XlsEntry } from "@/lib/types";

function parseTimeRange(label: string): { startTime: string; endTime: string } {
  const parts = label.split("|");
  const range = parts[1] ?? "";
  const times = range.split("-");
  return {
    startTime: (times[0] ?? "").trim(),
    endTime: (times[1] ?? "").replace(/\|.*$/, "").trim(),
  };
}

function extractSlotName(label: string): string {
  const idx = label.indexOf("|");
  if (idx === -1) return label.trim();
  return label.slice(0, idx).trim();
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** 将 XLS 日期单元格统一为 YYYYMMDD，避免导出时与数据库日期键不匹配 */
export function normalizeXlsDate(value: unknown): string {
  if (value == null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF?.parse_date_code?.(value);
    if (parsed) {
      return `${parsed.y}${pad2(parsed.m)}${pad2(parsed.d)}`;
    }
    const utc = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(utc);
    return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
  }

  const str = String(value).trim();
  if (/^\d{8}$/.test(str)) return str;

  const iso = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    return `${iso[1]}${pad2(Number(iso[2]))}${pad2(Number(iso[3]))}`;
  }

  const digits = str.replace(/\D/g, "");
  if (digits.length === 8) return digits;

  return "";
}

export function parseXlsFile(buffer: ArrayBuffer): XlsData {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];

  if (rows.length < 2) throw new Error("文件内容为空");

  const header = rows[0];
  // Header format: 管理组ID | 管理组名称 | 骑手ID | 骑手姓名 | 日期 | 骑手类型 | slot1 | slot2 | ...
  const slotStartIdx = header.findIndex((h) => h && (h.includes("|") || (h !== "管理组ID" && h !== "管理组名称" && h !== "骑手ID" && h !== "骑手姓名" && h !== "日期" && h !== "骑手类型")));

  let actualSlotStart = -1;
  for (let i = 0; i < header.length; i++) {
    const h = header[i]?.trim();
    if (h && h !== "管理组ID" && h !== "管理组名称" && h !== "骑手ID" && h !== "骑手姓名" && h !== "日期" && h !== "骑手类型") {
      actualSlotStart = i;
      break;
    }
  }

  const slots: XlsSlotDef[] = [];
  const slotLabels: string[] = [];
  const slotColumnIndexes: number[] = [];
  let slotOrder = 1;
  for (let i = actualSlotStart; i < header.length; i++) {
    const h = header[i];
    if (!h?.trim()) continue;
    slots.push({
      name: extractSlotName(h),
      startTime: parseTimeRange(h).startTime,
      endTime: parseTimeRange(h).endTime,
      sortOrder: slotOrder,
    });
    slotLabels.push(h);
    slotColumnIndexes.push(i);
    slotOrder += 1;
  }

  const groupId = String(rows[1]?.[0] ?? "").trim();
  const groupName = String(rows[1]?.[1] ?? "").trim();

  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (let r = 1; r < rows.length; r++) {
    const dateStr = normalizeXlsDate(rows[r]?.[4]);
    if (dateStr) {
      if (!minDate || dateStr < minDate) minDate = dateStr;
      if (!maxDate || dateStr > maxDate) maxDate = dateStr;
    }
  }

  const weekStart = minDate
    ? `${minDate.slice(0, 4)}-${minDate.slice(4, 6)}-${minDate.slice(6, 8)}`
    : "";
  const weekEnd = maxDate
    ? `${maxDate.slice(0, 4)}-${maxDate.slice(4, 6)}-${maxDate.slice(6, 8)}`
    : "";

  const entries: XlsEntry[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < actualSlotStart + 1) continue;

    const riderId = String(row[2] ?? "").trim();
    const riderName = String(row[3] ?? "").trim();
    const dateStr = normalizeXlsDate(row[4]);
    if (!riderId || !riderName || !dateStr) continue;

    const key = `${riderId}_${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const selections: number[] = [];
    for (let i = actualSlotStart; i < Math.min(row.length, actualSlotStart + slots.length); i++) {
      const val = parseInt(String(row[i] ?? "0"), 10);
      selections.push(isNaN(val) ? 0 : val);
    }

    entries.push({ riderId, riderName, date: dateStr, selections });
  }

  const columnCount = header.length;
  const snapshotRows = rows.slice(1).map((row) => {
    const arr: (string | number | null)[] = [];
    for (let i = 0; i < columnCount; i++) {
      const value = row?.[i];
      if (value === undefined) {
        arr.push("");
      } else if (i === 4) {
        arr.push(normalizeXlsDate(value));
      } else {
        arr.push(value as string | number | null);
      }
    }
    return arr;
  });

  return {
    weekStart,
    weekEnd,
    group: { id: groupId, name: groupName },
    slots,
    entries,
    slotLabels,
    slotColumnIndexes,
    baseColumnCount: actualSlotStart,
    snapshot: {
      header: header.slice(0, columnCount),
      rows: snapshotRows,
    },
  };
}
