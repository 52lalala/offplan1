import * as XLSX from "xlsx";
import type { XlsData, XlsSlotDef, XlsEntry } from "@/lib/types";

function parseTimeRange(label: string): { startTime: string; endTime: string } {
  const idx = label.indexOf("|");
  if (idx === -1) return { startTime: "00:00", endTime: "00:00" };
  const range = label.slice(idx + 1);
  const parts = range.split("-");
  return {
    startTime: parts[0]?.trim() ?? "00:00",
    endTime: parts[1]?.trim() ?? "00:00",
  };
}

function extractSlotName(label: string): string {
  const idx = label.indexOf("|");
  if (idx === -1) return label.trim();
  return label.slice(0, idx).trim();
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
  for (let i = actualSlotStart; i < header.length; i++) {
    const h = header[i];
    if (!h?.trim()) continue;
    slots.push({
      name: extractSlotName(h),
      startTime: parseTimeRange(h).startTime,
      endTime: parseTimeRange(h).endTime,
      sortOrder: i - actualSlotStart + 1,
    });
  }

  const groupId = String(rows[1]?.[0] ?? "").trim();
  const groupName = String(rows[1]?.[1] ?? "").trim();

  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (let r = 1; r < rows.length; r++) {
    const dateStr = String(rows[r]?.[4] ?? "").trim();
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
    const dateStr = String(row[4] ?? "").trim();
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

  return {
    weekStart,
    weekEnd,
    group: { id: groupId, name: groupName },
    slots,
    entries,
  };
}
