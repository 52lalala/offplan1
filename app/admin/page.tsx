"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { buildDaysFromRange, formatWeekRange } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import { parseXlsFile } from "@/lib/xls";
import type { ScheduleWeekRow, TimeSlotRow, RiderRow, RestDayLimitRow, RiderScheduleRow, XlsData } from "@/lib/types";

const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

function createDraftWeek(): ScheduleWeekRow {
  return {
    id: `draft-${crypto.randomUUID()}`,
    start_date: "",
    end_date: "",
    is_active: false,
  };
}

export default function AdminPage() {
  const [weeks, setWeeks] = useState<ScheduleWeekRow[]>([]);
  const [activeWeek, setActiveWeek] = useState<ScheduleWeekRow | null>(null);
  const [riderMap, setRiderMap] = useState<Record<string, RiderRow>>({});
  const [slots, setSlots] = useState<TimeSlotRow[]>([]);
  const [schedules, setSchedules] = useState<RiderScheduleRow[]>([]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [savingWeekId, setSavingWeekId] = useState<string | null>(null);
  const [editingMemberWeekId, setEditingMemberWeekId] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [showPendingOnly, setShowPendingOnly] = useState(false);

  const [importing, setImporting] = useState(false);
  const [previewData, setPreviewData] = useState<XlsData | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const weekDays = useMemo(() => {
    if (!activeWeek) return [];
    return buildDaysFromRange(activeWeek.start_date, activeWeek.end_date);
  }, [activeWeek]);

  const weekRiders = useMemo(() => {
    if (!activeWeek) return [];
    const riderIds = new Set(schedules.map((s) => s.rider_id));
    return Array.from(riderIds).map((id) => riderMap[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [activeWeek, schedules, riderMap]);

  const slotMap = useMemo(() => {
    const map: Record<string, TimeSlotRow> = {};
    for (const slot of slots) map[slot.id] = slot;
    return map;
  }, [slots]);

  const selectableSlotIds = useMemo(() => new Set(slots.filter((s) => s.is_selectable).map((s) => s.id)), [slots]);

  const namesWithShifts = useMemo(() => new Set(schedules.map((s) => s.rider_id)), [schedules]);

  const requestSummaries = useMemo(() => {
    const grouped = new Map<string, RiderScheduleRow[]>();
    for (const s of schedules) {
      const list = grouped.get(s.rider_id) ?? [];
      list.push(s);
      grouped.set(s.rider_id, list);
    }

    return Array.from(grouped.entries())
      .sort((a, b) => (riderMap[a[0]]?.name ?? "").localeCompare(riderMap[b[0]]?.name ?? "", "zh-CN"))
      .map(([riderId, riderSchedules]) => {
        const shiftsByDate = new Map<string, RiderScheduleRow[]>();
        for (const s of riderSchedules) {
          const list = shiftsByDate.get(s.work_date) ?? [];
          list.push(s);
          shiftsByDate.set(s.work_date, list);
        }

        const dayTexts = weekDays.map((day) => {
          const dayShifts = shiftsByDate.get(day.key);
          if (!dayShifts || dayShifts.length === 0) return `${day.weekdayLabel} 未生成`;

          const restEntry = dayShifts.find((s) => s.slot_id === null);
          if (restEntry) return `${day.weekdayLabel} 排休`;

          const selectedSlots = dayShifts
            .filter((s) => s.is_selected === true && s.slot_id !== null)
            .map((s) => (slotMap[s.slot_id!] ? slotMap[s.slot_id!].name : "?"));

          if (selectedSlots.length === 0) return `${day.weekdayLabel} 未选`;

          return `${day.weekdayLabel} ${selectedSlots.join("、")}`;
        });

        return { riderId, riderName: riderMap[riderId]?.name ?? riderId, dayTexts };
      });
  }, [riderMap, schedules, slotMap, weekDays]);

  useEffect(() => {
    async function load() {
      const [weeksRes, ridersRes] = await Promise.all([
        supabase.from("schedule_weeks").select("*").order("start_date", { ascending: false }),
        supabase.from("riders").select("*"),
      ]);
      if (weeksRes.data) {
        setWeeks(weeksRes.data);
        setActiveWeek(weeksRes.data.find((w) => w.is_active) ?? weeksRes.data[0] ?? null);
      }
      if (ridersRes.data) {
        setRiderMap(ridersRes.data.reduce<Record<string, RiderRow>>((acc, r) => { acc[r.rider_id] = r; return acc; }, {}));
      }
    }
    void load();
  }, []);

  useEffect(() => {
    if (!activeWeek) { setSlots([]); setSchedules([]); setLimits({}); return; }
    const curWeek = activeWeek;
    const ws = curWeek.start_date;
    async function loadWeek() {
      const [slotsRes, schedulesRes, limitsRes, ridersRes] = await Promise.all([
        supabase.from("time_slots").select("*").eq("week_id", curWeek.id).order("sort_order"),
        supabase.from("rider_schedules").select("*").eq("week_id", curWeek.id),
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", ws),
        supabase.from("riders").select("*"),
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
      .on("postgres_changes", { event: "*", schema: "public", table: "riders" }, async () => {
        const { data } = await supabase.from("riders").select("*");
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
      return;
    }
    const week = weeks.find((w) => w.id === weekId);
    if (week) {
      await Promise.all([
        supabase.from("rider_schedules").delete().eq("week_id", weekId),
        supabase.from("rest_day_limits").delete().eq("week_start", week.start_date),
      ]);
    }
    const { error } = await supabase.from("schedule_weeks").delete().eq("id", weekId);
    setSavingWeekId(null);
    if (error) { setMessage(error.message); return; }
    if (activeWeek?.id === weekId) setActiveWeek(null);
    setMessage("排休周已删除。");
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const data = parseXlsFile(buf);
      setPreviewData(data);
      setMessage(`解析完成：${data.slots.length} 个时段，${data.entries.length} 条排班记录`);
    } catch (e: unknown) {
      setMessage(`解析失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
    event.target.value = "";
  }

  async function confirmImport() {
    if (!activeWeek || !previewData) return;
    setImporting(true);
    setMessage(null);
    const { error } = await supabase.rpc("import_xls_week", {
      p_week_id: activeWeek.id,
      p_data: previewData,
    });
    setImporting(false);
    if (error) { setMessage(error.message); return; }
    setPreviewData(null);
    setMessage("导入成功");
  }

  async function clearSchedules() {
    if (!activeWeek) return;
    setMessage(null);
    const { error } = await supabase.rpc("clear_week_schedules", { p_week_id: activeWeek.id });
    if (error) { setMessage(error.message); return; }
    setMessage("排班已清空");
  }

  async function toggleSlotSelectable(slotId: string) {
    const { error } = await supabase.rpc("toggle_slot_selectable", { p_slot_id: slotId });
    if (error) setMessage(error.message);
  }

  async function setMinSlots(riderId: string, minSlots: number) {
    const { error } = await supabase.rpc("set_rider_min_slots", { p_rider_id: riderId, p_min_slots: minSlots });
    if (error) setMessage(error.message);
  }

  async function saveAllLimits() {
    if (!activeWeek) return;
    setSavingAll(true);
    setMessage(null);
    const rows = weekDays.map((day) => ({
      week_start: activeWeek.start_date,
      rest_date: day.key,
      max_slots: limits[day.key] ?? getDefaultLimit(day.key),
    }));
    const { error } = await supabase.from("rest_day_limits").upsert(rows, { onConflict: "week_start,rest_date" });
    setSavingAll(false);
    if (error) { setMessage(error.message); return; }
    setMessage("名额已保存");
  }

  return (
    <main className="page-container">
      <header className="page-header">
        <h1>后台管理</h1>
        <p>XLS 导入 · 骑手时段配置 · 排班总览</p>
      </header>
      {message ? <div className="toast-pill">{message}</div> : null}

      {/* 排班周配置 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>排班周配置</h2>
            <p>启用周决定员工端展示哪一周</p>
          </div>
          <button className="btn-primary btn-sm" type="button" onClick={() => setWeeks((cur) => [createDraftWeek(), ...cur])}>+ 新增一周</button>
        </div>
        <div className="config-grid">
          {weeks.map((week) => (
            <div className={`config-card ${week.is_active ? "active-card" : ""}`} key={week.id}>
              <div className="input-group">
                <input type="date" className="clean-input" value={week.start_date}
                  onChange={(e) => setWeeks((cur) => cur.map((w) => w.id === week.id ? { ...w, start_date: e.target.value } : w))} />
                <input type="date" className="clean-input" value={week.end_date}
                  onChange={(e) => setWeeks((cur) => cur.map((w) => w.id === week.id ? { ...w, end_date: e.target.value } : w))} />
                <label className="switch-label">
                  <input type="checkbox" checked={week.is_active}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setWeeks((cur) => cur.map((w) => ({ ...w, is_active: w.id === week.id ? checked : w.is_active })));
                      if (checked) setActiveWeek(week);
                    }} />
                  发布此周
                </label>
              </div>
              {!week.id.startsWith("draft-") ? (
                <div className="link-row">
                  <span className="link-url">{typeof window !== "undefined" ? `${window.location.origin}/week/${week.id}` : `/week/${week.id}`}</span>
                  <button className="btn-ghost btn-sm" type="button"
                    onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/week/${week.id}`); setMessage("链接已复制"); }}>
                    复制链接
                  </button>
                  <button className="btn-ghost btn-sm" type="button" onClick={() => setActiveWeek(week)}>查看总览</button>
                </div>
              ) : null}
              <div className="card-actions-row">
                <button className="btn-primary btn-sm" type="button" disabled={savingWeekId === week.id} onClick={() => saveWeek(week)}>保存</button>
                <button className="btn-ghost btn-sm" type="button" disabled={savingWeekId === week.id} onClick={() => deleteWeek(week.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* XLS 导入 */}
      {activeWeek ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>XLS 导入排班</h2>
              <p>当前周：{formatWeekRange(activeWeek.start_date, activeWeek.end_date)}</p>
            </div>
          </div>

          {!previewData ? (
            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
              <input ref={fileInputRef} type="file" accept=".xls,.xlsx" style={{ display: "none" }} onChange={handleFileUpload} />
              <button className="btn-primary" type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                选择 XLS 文件
              </button>
              <button className="btn-ghost btn-sm" type="button" onClick={clearSchedules} style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}>
                清空排班
              </button>
              {activeWeek && slots.length > 0 && weekRiders.length === 0 ? (
                <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>已有时段但无排班数据，可导入 XLS</span>
              ) : null}
              {activeWeek && slots.length === 0 ? (
                <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>尚未导入，请选择文件</span>
              ) : null}
            </div>
          ) : (
            <div style={{ background: "var(--surface-muted)", borderRadius: "12px", padding: "16px" }}>
              <p style={{ margin: "0 0 12px", fontWeight: 600 }}>导入预览</p>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: "14px", marginBottom: "12px" }}>
                <span style={{ color: "var(--text-muted)" }}>时段：</span><span>{previewData.slots.map((s) => s.name).join("、")}</span>
                <span style={{ color: "var(--text-muted)" }}>骑手：</span><span>{new Set(previewData.entries.map((e) => e.riderId)).size} 人</span>
                <span style={{ color: "var(--text-muted)" }}>记录：</span><span>{previewData.entries.length} 条</span>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn-primary" type="button" onClick={confirmImport} disabled={importing}>
                  {importing ? "导入中..." : "确认导入"}
                </button>
                <button className="btn-ghost btn-sm" type="button" onClick={() => setPreviewData(null)} style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}>
                  取消
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {/* 时段配置 */}
      {activeWeek && slots.length > 0 ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>时段配置</h2>
              <p>标记「可选」的时段骑手可在端上自由选择</p>
            </div>
          </div>
          <div className="config-grid">
            {slots.map((slot) => (
              <div className="config-card" key={slot.id} style={{ flexDirection: "row", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <strong>{slot.name}</strong>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>{slot.start_time.slice(0, 5)}-{slot.end_time.slice(0, 5)}</span>
                </div>
                <label className="switch-label" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={slot.is_selectable} onChange={() => toggleSlotSelectable(slot.id)} />
                  可选
                </label>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 骑手管理 */}
      {activeWeek && weekRiders.length > 0 ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>骑手管理</h2>
              <p>设置每人每天最少选时段数（仅计算可选时段）</p>
            </div>
          </div>
          <div className="config-grid">
            {weekRiders.map((rider) => (
              <div className="config-card" key={rider.rider_id} style={{ flexDirection: "row", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <strong>{rider.name}</strong>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>ID: {rider.rider_id}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>最少选</span>
                  <input className="clean-input" type="number" min={0} max={10} value={rider.min_slots}
                    onChange={(e) => setRiderMap((cur) => ({ ...cur, [rider.rider_id]: { ...cur[rider.rider_id], min_slots: Number(e.target.value) } }))}
                    onBlur={() => setMinSlots(rider.rider_id, rider.min_slots)}
                    style={{ width: "60px", padding: "6px", textAlign: "center" }} />
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>个时段</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 排班总览 */}
      {activeWeek ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>排班总览</h2>
              <p>{activeWeek ? formatWeekRange(activeWeek.start_date, activeWeek.end_date) : "未选择周"}</p>
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
                仅显示未排班
              </label>
            </>
          ) : <p style={{ fontSize: "14px", color: "var(--text-muted)" }}>暂无排班数据，请导入 XLS</p>}

          {requestSummaries.length > 0 ? (
            <div className="table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>骑手 ({requestSummaries.length}人)</th>
                    {weekDays.map((day) => (
                      <th key={day.key}>{day.weekdayLabel}<br /><span style={{ fontWeight: "normal", fontSize: "12px" }}>{day.shortDate}</span></th>
                    ))}
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

      {/* 每日休息名额 */}
      {activeWeek && weekDays.length > 0 ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>每日休息名额配额</h2>
              <p>排班率 = (总人数 − 已排休人数) / 总人数</p>
            </div>
          </div>
          <div className="config-grid">
            {weekDays.map((day) => {
              const usedRest = schedules.filter((s) => s.work_date === day.key && s.slot_id === null).length;
              const maxSlots = limits[day.key] ?? getDefaultLimit(day.key);
              const total = weekRiders.length;
              const ratio = total > 0 ? ((total - usedRest) / total * 100).toFixed(0) + "%" : "-";
              return (
                <div className="config-card" key={day.key} style={{ flexDirection: "row", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <strong>{day.weekdayLabel}</strong>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>{day.shortDate} · 已休 {usedRest}人 · 总 {total}人 · 排班率 {ratio}</span>
                  </div>
                  <div style={{ width: "80px" }}>
                    <input className="clean-input" type="number" min={0} max={50} value={maxSlots}
                      onChange={(e) => setLimits((cur) => ({ ...cur, [day.key]: Number(e.target.value) }))}
                      style={{ padding: "8px", textAlign: "center" }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
            <button className="btn-primary" type="button" disabled={savingAll} onClick={saveAllLimits}>
              {savingAll ? "保存中..." : "保存"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
