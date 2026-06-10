"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { buildDaysFromRange, formatWeekRange, getWeekStart, formatDateKey } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import { parseXlsFile } from "@/lib/xls";
import type { ScheduleWeekRow, TimeSlotRow, RiderRow, RestDayLimitRow, RiderScheduleRow, ExportXlsData } from "@/lib/types";

const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;

function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

function createDraftWeek(): ScheduleWeekRow {
  const monday = getWeekStart();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return {
    id: `draft-${uid()}`,
    name: "",
    start_date: formatDateKey(monday),
    end_date: formatDateKey(sunday),
    is_active: false,
    required_slots: 3,
    default_slot_ids: null,
  };
}

export default function AdminPage() {
  const router = useRouter();
  const [weeks, setWeeks] = useState<ScheduleWeekRow[]>([]);
  const [loadingWeeks, setLoadingWeeks] = useState(true);
  const [activeWeek, setActiveWeek] = useState<ScheduleWeekRow | null>(null);
  const [riderMap, setRiderMap] = useState<Record<string, RiderRow>>({});
  const [slots, setSlots] = useState<TimeSlotRow[]>([]);
  const [schedules, setSchedules] = useState<RiderScheduleRow[]>([]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [savingWeekId, setSavingWeekId] = useState<string | null>(null);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newWeekName, setNewWeekName] = useState("");
  const [newWeekStart, setNewWeekStart] = useState("");
  const [newWeekEnd, setNewWeekEnd] = useState("");
  const [creating, setCreating] = useState(false);
  const [importingWeekId, setImportingWeekId] = useState<string | null>(null);
  const [exportingWeekId, setExportingWeekId] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  const weekDays = useMemo(() => {
    if (!activeWeek) return [];
    return buildDaysFromRange(activeWeek.start_date, activeWeek.end_date);
  }, [activeWeek]);

  const weekRiders = useMemo(() => {
    if (!activeWeek) return [];
    // 显示所有导入的骑手，而不仅仅是有排班数据的
    return Object.values(riderMap).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [activeWeek, riderMap]);

  const slotMap = useMemo(() => {
    const map: Record<string, TimeSlotRow> = {};
    for (const slot of slots) map[slot.id] = slot;
    return map;
  }, [slots]);

  const selectableSlotIds = useMemo(() => new Set(slots.filter((s) => s.is_selectable).map((s) => s.id)), [slots]);

  const namesWithShifts = useMemo(() => new Set(schedules.map((s) => s.rider_id)), [schedules]);

  const restCounts = useMemo(() => {
    const counts: Record<string, { used: number; limit: number }> = {};
    for (const day of weekDays) {
      const used = schedules.filter((s) => s.work_date === day.key && s.slot_id === null).length;
      const limit = limits[day.key] ?? getDefaultLimit(day.key);
      counts[day.key] = { used, limit };
    }
    return counts;
  }, [schedules, weekDays, limits]);

  const requestSummaries = useMemo(() => {
    const grouped = new Map<string, RiderScheduleRow[]>();
    for (const schedule of schedules) {
      const list = grouped.get(schedule.rider_id) ?? [];
      list.push(schedule);
      grouped.set(schedule.rider_id, list);
    }

    return Array.from(grouped.entries())
      .sort((a, b) => (riderMap[a[0]]?.name ?? "").localeCompare(riderMap[b[0]]?.name ?? "", "zh-CN"))
      .map(([riderId, riderSchedules]) => {
        const shiftsByDate = new Map<string, RiderScheduleRow[]>();
        for (const schedule of riderSchedules) {
          const list = shiftsByDate.get(schedule.work_date) ?? [];
          list.push(schedule);
          shiftsByDate.set(schedule.work_date, list);
        }

        const dayTexts = weekDays.map((day) => {
          const dayShifts = shiftsByDate.get(day.key);
          if (!dayShifts || dayShifts.length === 0) return `${day.weekdayLabel} 未生成`;

          const restEntry = dayShifts.find((shift) => shift.slot_id === null);
          if (restEntry) return `${day.weekdayLabel} 排休`;

          const selectedSlots = dayShifts
            .filter((shift) => shift.is_selected === true && shift.slot_id !== null)
            .map((shift) => (slotMap[shift.slot_id!] ? slotMap[shift.slot_id!].name : "?"));

          if (selectedSlots.length === 0) return `${day.weekdayLabel} 未选`;

          return `${day.weekdayLabel} ${selectedSlots.join("、")}`;
        });

        return { riderId, riderName: riderMap[riderId]?.name ?? riderId, dayTexts };
      });
  }, [riderMap, schedules, slotMap, weekDays]);

  async function handleXlsExport(week: ScheduleWeekRow) {
    setExportingWeekId(week.id);
    setMessage(null);
    try {
      const { data, error } = await supabase.rpc("export_xls_week", { p_week_id: week.id });
      if (error) {
        setMessage(`导出失败：${error.message}`);
        return;
      }
      if (!data) {
        setMessage("导出失败：未获取到数据");
        return;
      }

      const payload = data as ExportXlsData;
      const toArray = (value: unknown): (string | number | null)[] => (Array.isArray(value) ? value : []);
      const header = toArray(payload.header);
      const rows = (Array.isArray(payload.rows) ? payload.rows : []).map(toArray);
      const aoa = [header, ...rows].map((row) => row.map((cell) => (cell ?? "")));

      const worksheet = XLSX.utils.aoa_to_sheet(aoa);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "排班数据");

      const fileName = `${week.name || formatWeekRange(week.start_date, week.end_date)}-排班.xls`;
      XLSX.writeFile(workbook, fileName, { bookType: 'xls' });
      setMessage(payload.generated ? "导出成功（基于当前排班生成）" : "导出成功（保持导入模板结构）");
    } catch (err: unknown) {
      setMessage(`导出失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setExportingWeekId(null);
    }
  }

  useEffect(() => {
    async function load() {
      setLoadingWeeks(true);
      const weeksRes = await supabase.from("schedule_weeks").select("*").order("start_date", { ascending: false });
      if (weeksRes.data) {
        setWeeks(weeksRes.data);
        const savedWeekId = typeof window !== "undefined" ? localStorage.getItem("admin-selected-week-id") : null;
        const savedWeek = savedWeekId ? weeksRes.data.find((w) => w.id === savedWeekId) : null;
        setActiveWeek(savedWeek ?? weeksRes.data.find((w) => w.is_active) ?? weeksRes.data[0] ?? null);
      }
      setLoadingWeeks(false);
    }
    void load();
  }, []);

  useEffect(() => {
    if (!activeWeek) { setSlots([]); setSchedules([]); setLimits({}); setRiderMap({}); return; }
    const curWeek = activeWeek;
    const ws = curWeek.start_date;
    async function loadWeek() {
      const [slotsRes, schedulesRes, limitsRes, ridersRes] = await Promise.all([
        supabase.from("time_slots").select("*").eq("week_id", curWeek.id).order("sort_order"),
        supabase.from("rider_schedules").select("*").eq("week_id", curWeek.id),
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", ws),
        supabase.from("riders").select("*").eq("week_id", curWeek.id),
      ]);
      if (slotsRes.data) setSlots(slotsRes.data);
      if (schedulesRes.data) setSchedules(schedulesRes.data);
      if (limitsRes.data) {
        setLimits(limitsRes.data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
      }
      if (ridersRes.data) {
        setRiderMap(ridersRes.data.reduce<Record<string, RiderRow>>((acc, r) => { acc[r.rider_id] = r; return acc; }, {}));
      }
    }
    void loadWeek();
  }, [activeWeek]);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 2500);
    return () => window.clearTimeout(t);
  }, [message]);

  useEffect(() => {
    const channel = supabase
      .channel(`admin-sync-${activeWeek?.id ?? "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "schedule_weeks" }, async () => {
        const { data } = await supabase.from("schedule_weeks").select("*").order("start_date", { ascending: false });
        if (data) {
          setWeeks(data);
          setActiveWeek((cur) => data.find((w) => w.id === cur?.id) ?? data.find((w) => w.is_active) ?? data[0] ?? null);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "time_slots" }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("time_slots").select("*").eq("week_id", activeWeek.id).order("sort_order");
        if (data) setSlots(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rider_schedules", filter: activeWeek ? `week_id=eq.${activeWeek.id}` : undefined }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("rider_schedules").select("*").eq("week_id", activeWeek.id);
        if (data) setSchedules(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_day_limits" }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", activeWeek.start_date);
        if (data) setLimits(data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "riders", filter: activeWeek ? `week_id=eq.${activeWeek.id}` : undefined }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("riders").select("*").eq("week_id", activeWeek.id);
        if (data) setRiderMap(data.reduce<Record<string, RiderRow>>((acc, r) => { acc[r.rider_id] = r; return acc; }, {}));
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [activeWeek]);

  async function saveWeek(week: ScheduleWeekRow) {
    if (!week.start_date || !week.end_date) { setMessage("请完整填写起止日期。"); return; }
    setSavingWeekId(week.id);
    setMessage(null);
    const isDraft = week.id.startsWith("draft-");
    const payload = {
      ...(isDraft ? {} : { id: week.id }),
      start_date: week.start_date,
      end_date: week.end_date,
      is_active: week.is_active,
      required_slots: week.required_slots ?? 3,
      default_slot_ids: week.default_slot_ids,
    };
    const { data, error } = await supabase.from("schedule_weeks").upsert(payload).select("id").single();
    if (error) { setSavingWeekId(null); setMessage(error.message); return; }
    const newWeekId = data?.id ?? week.id;

    if (isDraft) {
      const sourceWeek = weeks.filter((w) => !w.id.startsWith("draft-")).sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
      if (sourceWeek) {
        const { data: hasSlots } = await supabase.from("time_slots").select("id").eq("week_id", sourceWeek.id).limit(1).maybeSingle();
        if (hasSlots) {
          await supabase.rpc("clone_week_slots", { p_source_week_id: sourceWeek.id, p_target_week_id: newWeekId });
        }
      }
      setWeeks((cur) => cur.filter((w) => w.id !== week.id));
    }

    setSavingWeekId(null);
    setMessage("排休周已保存。");
  }

  async function deleteWeek(weekId: string) {
    setSavingWeekId(weekId);
    setMessage(null);
    if (weekId.startsWith("draft-")) {
      setWeeks((cur) => cur.filter((w) => w.id !== weekId));
      setSavingWeekId(null);
      setShowDeleteConfirm(null);
      return;
    }
    const week = weeks.find((w) => w.id === weekId);
    if (week) {
      await Promise.all([
        supabase.from("rest_day_limits").delete().eq("week_start", week.start_date),
      ]);
    }
    const { error } = await supabase.from("schedule_weeks").delete().eq("id", weekId);
    setSavingWeekId(null);
    if (error) { setMessage(error.message); return; }
    if (activeWeek?.id === weekId) setActiveWeek(null);
    setShowDeleteConfirm(null);
    setMessage("排休周已删除。");
  }

  async function handleCreateWeek() {
    if (!newWeekName.trim() || !newWeekStart || !newWeekEnd) {
      setMessage("请填写完整的名称和日期");
      return;
    }
    setCreating(true);
    setMessage(null);
    const { data, error } = await supabase.from("schedule_weeks").insert({
      name: newWeekName.trim(),
      start_date: newWeekStart,
      end_date: newWeekEnd,
      is_active: false,
      required_slots: 3,
    }).select().single();
    setCreating(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    if (data) {
      setWeeks((cur) => [data, ...cur]);
      setShowCreateModal(false);
      setNewWeekName("");
      setNewWeekStart("");
      setNewWeekEnd("");
      setMessage("排休周已创建，点击编辑配置进行详细设置");
    }
  }

  async function handleXlsImport(weekId: string, event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportingWeekId(weekId);
    setMessage(null);
    try {
      const buf = await file.arrayBuffer();
      const data = parseXlsFile(buf);
      const { error } = await supabase.rpc("import_xls_week", {
        p_week_id: weekId,
        p_data: data,
      });
      if (error) {
        setMessage(`导入失败：${error.message}`);
      } else {
        setMessage("导入成功");
      }
    } catch (e: unknown) {
      setMessage(`解析失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
    setImportingWeekId(null);
    event.target.value = "";
  }

  return (
    <main className="page-container">
      <header className="page-header">
        <h1>后台管理</h1>
        <p>排班周管理 · 排班总览</p>
      </header>
      {message ? <div className="toast-pill">{message}</div> : null}

      {/* 排班周配置 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>排班周配置</h2>
            <p>点击卡片切换排班总览</p>
          </div>
          <button className="btn-primary btn-sm" type="button" onClick={() => setShowCreateModal(true)}>+ 新增一周</button>
        </div>
        {loadingWeeks ? (
          <div className="empty-state">加载中...</div>
        ) : (
          <div className="config-grid">
            {weeks.map((week) => (
              <div
                className={`config-card ${activeWeek?.id === week.id ? "active-card" : ""}`}
                key={week.id}
                style={{ position: "relative", cursor: "pointer" }}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest("button") && !(e.target as HTMLElement).closest("input")) {
                    setActiveWeek(week);
                    localStorage.setItem("admin-selected-week-id", week.id);
                  }
                }}
              >
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ position: "absolute", top: "12px", right: "12px", padding: "4px 8px", color: "#ef4444", fontSize: "12px" }}
                  disabled={savingWeekId === week.id}
                  onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(week.id); }}
                >
                  删除
                </button>
                <div className="input-group" style={{ paddingRight: "32px" }}>
                  <strong style={{ fontSize: "16px" }}>{week.name || formatWeekRange(week.start_date, week.end_date)}</strong>
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                    {week.start_date} ~ {week.end_date}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {typeof window !== "undefined" ? `${window.location.origin}/week/${week.id}` : `/week/${week.id}`}
                  </span>
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(`${window.location.origin}/week/${week.id}`); setMessage("链接已复制"); }}
                    style={{ padding: "4px 8px", border: "1px solid var(--border-color)", fontSize: "12px", color: "var(--text-muted)" }}
                    title="复制"
                  >
                    复制
                  </button>
                </div>
                <div className="card-actions-row">
                  <button
                    className="btn-primary btn-sm"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); router.push(`/admin/${week.id}`); }}
                  >
                    编辑配置
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    type="button"
                    disabled={exportingWeekId === week.id}
                    onClick={(e) => { e.stopPropagation(); void handleXlsExport(week); }}
                    style={{ color: "var(--text-muted)" }}
                  >
                    {exportingWeekId === week.id ? "导出中..." : "导出XLS"}
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    type="button"
                    disabled={importingWeekId === week.id}
                    onClick={(e) => { e.stopPropagation(); fileInputRefs.current[week.id]?.click(); }}
                    style={{ color: "var(--text-muted)" }}
                  >
                    {importingWeekId === week.id ? "导入中..." : "导入XLS"}
                  </button>
                </div>
                <input
                  ref={(el) => { fileInputRefs.current[week.id] = el; }}
                  type="file"
                  accept=".xls,.xlsx"
                  style={{ display: "none" }}
                  onChange={(e) => handleXlsImport(week.id, e)}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 排班总览 */}
      {activeWeek ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>排班总览</h2>
              <p>{activeWeek ? formatWeekRange(activeWeek.start_date, activeWeek.end_date) : "未选择周"} · 总人数 {weekRiders.length} · 已排班 {namesWithShifts.size}</p>
            </div>
          </div>
          {weekRiders.length > 0 ? (
            <>
              <div className="member-tags">
                {(showPendingOnly ? weekRiders.filter((r) => !namesWithShifts.has(r.rider_id)) : weekRiders).map((r) => (
                  <span key={r.rider_id} className={`member-tag ${namesWithShifts.has(r.rider_id) ? "" : "member-tag-pending"}`}>
                    {r.name}
                  </span>
                ))}
              </div>
              <label className="switch-label" style={{ marginBottom: "12px" }}>
                <input type="checkbox" checked={showPendingOnly} onChange={(e) => setShowPendingOnly(e.target.checked)} />
                仅显示未排班 ({weekRiders.filter((r) => !namesWithShifts.has(r.rider_id)).length}人)
              </label>
            </>
          ) : <p style={{ fontSize: "14px", color: "var(--text-muted)" }}>暂无骑手名单，请导入 XLS</p>}

          {requestSummaries.length > 0 ? (
            <div className="table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>骑手 ({requestSummaries.length}人)</th>
                    {weekDays.map((day) => {
                      const rc = restCounts[day.key] ?? { used: 0, limit: 0 };
                      const full = rc.used >= rc.limit;
                      return (
                        <th key={day.key}>
                          {day.weekdayLabel}<br />
                          <span style={{ fontWeight: "normal", fontSize: "12px" }}>{day.shortDate}</span><br />
                          <span style={{ fontWeight: "normal", fontSize: "11px", color: full ? "#ef4444" : "var(--text-muted)" }}>
                            休息日：{rc.used}/{rc.limit}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {requestSummaries.map((item) => (
                    <tr key={item.riderId}>
                      <td>{item.riderName}</td>
                      {item.dayTexts.map((text, i) => {
                        const state = text.substring(text.indexOf(" ") + 1);
                        let cls = "work";
                        if (state === "排休") cls = "rest";
                        if (state === "未生成" || state === "未选") cls = "missing";
                        return <td key={i}><span className={`status-badge ${cls}`}>{state}</span></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="overlay" onClick={() => setShowDeleteConfirm(null)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <h2>确认删除</h2>
            <p style={{ margin: "0 0 20px 0", color: "var(--text-muted)" }}>删除后将无法恢复，确定要删除这个排班周吗？</p>
            <div className="card-actions-row">
              <button className="btn-ghost" type="button" onClick={() => setShowDeleteConfirm(null)}>取消</button>
              <button
                className="btn-primary"
                type="button"
                style={{ backgroundColor: "#ef4444" }}
                onClick={() => deleteWeek(showDeleteConfirm)}
                disabled={savingWeekId === showDeleteConfirm}
              >
                {savingWeekId === showDeleteConfirm ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建周弹窗 */}
      {showCreateModal && (
        <div className="overlay" onClick={() => setShowCreateModal(false)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <h2>创建排班周</h2>
            <div className="input-group">
              <label>排班名称</label>
              <input
                className="clean-input"
                type="text"
                value={newWeekName}
                onChange={(e) => setNewWeekName(e.target.value)}
                placeholder="例如：第一周、A队排班等"
                autoFocus
              />
            </div>
            <div className="input-group">
              <label>开始日期</label>
              <input
                className="clean-input"
                type="date"
                value={newWeekStart}
                onChange={(e) => setNewWeekStart(e.target.value)}
              />
            </div>
            <div className="input-group">
              <label>结束日期</label>
              <input
                className="clean-input"
                type="date"
                value={newWeekEnd}
                onChange={(e) => setNewWeekEnd(e.target.value)}
              />
            </div>
            <div className="card-actions-row" style={{ marginTop: "16px" }}>
              <button className="btn-ghost" type="button" onClick={() => setShowCreateModal(false)}>取消</button>
              <button className="btn-primary" type="button" onClick={handleCreateWeek} disabled={creating}>
                {creating ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
