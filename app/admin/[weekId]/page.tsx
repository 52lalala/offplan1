"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { buildDaysFromRange, formatWeekRange, getWeekStart, formatDateKey } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import type { ScheduleWeekRow, TimeSlotRow, RestDayLimitRow, RiderScheduleRow } from "@/lib/types";

const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

export default function WeekEditPage() {
  const params = useParams();
  const router = useRouter();
  const weekId = params.weekId as string;

  const [week, setWeek] = useState<ScheduleWeekRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [slots, setSlots] = useState<TimeSlotRow[]>([]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);

  const weekDays = useMemo(() => {
    if (!week) return [];
    return buildDaysFromRange(week.start_date, week.end_date);
  }, [week]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [weekRes, slotsRes, limitsRes] = await Promise.all([
        supabase.from("schedule_weeks").select("*").eq("id", weekId).maybeSingle(),
        supabase.from("time_slots").select("*").eq("week_id", weekId).order("sort_order"),
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", week?.start_date || ""),
      ]);
      setWeek(weekRes.data ?? null);
      setSlots(slotsRes.data ?? []);
      if (limitsRes.data) {
        setLimits(limitsRes.data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
      }
      setLoading(false);
    }
    void load();
  }, [weekId]);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 2500);
    return () => window.clearTimeout(t);
  }, [message]);

  useEffect(() => {
    const channel = supabase
      .channel(`week-edit-${weekId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "schedule_weeks", filter: `id=eq.${weekId}` }, async () => {
        const { data } = await supabase.from("schedule_weeks").select("*").eq("id", weekId).maybeSingle();
        if (data) setWeek(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "time_slots", filter: `week_id=eq.${weekId}` }, async () => {
        const { data } = await supabase.from("time_slots").select("*").eq("week_id", weekId).order("sort_order");
        if (data) setSlots(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_day_limits", filter: week ? `week_start=eq.${week.start_date}` : undefined }, async () => {
        if (!week) return;
        const { data } = await supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", week.start_date);
        if (data) setLimits(data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [weekId, week]);

  async function saveWeek() {
    if (!week?.start_date || !week?.end_date) { setMessage("请完整填写起止日期。"); return; }
    setMessage(null);
    const { error } = await supabase.from("schedule_weeks").update({
      start_date: week.start_date,
      end_date: week.end_date,
      is_active: week.is_active,
      required_slots: week.required_slots ?? 3,
    }).eq("id", weekId);
    if (error) { setMessage(error.message); return; }
    setMessage("排休周已保存。");
  }

  async function toggleSlotSelectable(slotId: string) {
    const { error } = await supabase.rpc("toggle_slot_selectable", { p_slot_id: slotId });
    if (error) setMessage(error.message);
  }

  async function setWeekRequiredSlots(requiredSlots: number) {
    const { error } = await supabase.rpc("set_week_required_slots", { p_week_id: weekId, p_required_slots: requiredSlots });
    if (error) setMessage(error.message);
  }

  async function saveAllLimits() {
    if (!week) return;
    setMessage(null);
    const rows = weekDays.map((day) => ({
      week_start: week.start_date,
      rest_date: day.key,
      max_slots: limits[day.key] ?? getDefaultLimit(day.key),
    }));
    const { error } = await supabase.from("rest_day_limits").upsert(rows, { onConflict: "week_start,rest_date" });
    if (error) { setMessage(error.message); return; }
    setMessage("名额已保存");
  }

  if (loading) {
    return (
      <main className="page-container">
        <div className="loading-spinner"><div className="spinner" /><span className="loading-text">加载中...</span></div>
      </main>
    );
  }

  if (!week) {
    return (
      <main className="page-container">
        <header className="page-header">
          <h1>排班配置</h1>
          <p>该周不存在或已被删除</p>
        </header>
        <div className="empty-state">请联系管理员获取新的排班链接。</div>
        <button className="btn-primary" type="button" onClick={() => router.push("/admin")}>返回管理端</button>
      </main>
    );
  }

  return (
    <main className="page-container">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button className="btn-ghost btn-sm" type="button" onClick={() => router.push("/admin")}>← 返回</button>
          <h1>排班配置</h1>
        </div>
        <p>{formatWeekRange(week.start_date, week.end_date)}</p>
      </header>
      {message ? <div className="toast-pill">{message}</div> : null}

      {/* 日期配置 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>日期配置</h2>
            <p>设置排休周的名称、起止日期和状态</p>
          </div>
        </div>
        <div className="config-card" style={{ maxWidth: "600px" }}>
          <div className="input-group">
            <label style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>排班名称</label>
            <input type="text" className="clean-input" value={week.name}
              onChange={(e) => setWeek((cur) => cur ? { ...cur, name: e.target.value } : null)} placeholder="例如：第一周、A队排班等" />
          </div>
          <div className="input-group">
            <label style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>开始日期</label>
            <input type="date" className="clean-input" value={week.start_date}
              onChange={(e) => setWeek((cur) => cur ? { ...cur, start_date: e.target.value } : null)} />
          </div>
          <div className="input-group">
            <label style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>结束日期</label>
            <input type="date" className="clean-input" value={week.end_date}
              onChange={(e) => setWeek((cur) => cur ? { ...cur, end_date: e.target.value } : null)} />
          </div>
          <label className="switch-label" style={{ marginTop: "8px" }}>
            <input type="checkbox" checked={week.is_active}
              onChange={(e) => setWeek((cur) => cur ? { ...cur, is_active: e.target.checked } : null)} />
            发布此周
          </label>
          <div className="card-actions-row" style={{ marginTop: "16px" }}>
            <button className="btn-primary" type="button" onClick={saveWeek}>保存</button>
          </div>
        </div>
      </section>

      {/* 时段配置 */}
      {slots.length > 0 ? (
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

      {/* 每周必须选时段数 */}
      {slots.length > 0 ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>排班要求</h2>
              <p>规定每人每天必须选几个时段</p>
            </div>
          </div>
          <div className="config-card" style={{ flexDirection: "row", alignItems: "center", maxWidth: "400px" }}>
            <div style={{ flex: 1 }}>
              <strong>每人每天必须选</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <input className="clean-input" type="number" min={0} max={10} value={week.required_slots ?? 3}
                onChange={(e) => setWeek((cur) => cur ? { ...cur, required_slots: Number(e.target.value) } : null)}
                onBlur={() => setWeekRequiredSlots(week.required_slots ?? 3)}
                style={{ width: "60px", padding: "6px", textAlign: "center" }} />
              <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>个时段</span>
            </div>
          </div>
        </section>
      ) : null}

      {/* 每日休息名额 */}
      {weekDays.length > 0 ? (
        <section className="admin-section">
          <div className="section-header">
            <div>
              <h2>每日休息名额配额</h2>
              <p>设置每天的排休名额上限</p>
            </div>
          </div>
          <div className="config-grid">
            {weekDays.map((day) => {
              const maxSlots = limits[day.key] ?? getDefaultLimit(day.key);
              return (
                <div className="config-card" key={day.key} style={{ flexDirection: "row", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <strong>{day.weekdayLabel}</strong>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>{day.shortDate}</span>
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
            <button className="btn-primary" type="button" onClick={saveAllLimits}>
              保存
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
