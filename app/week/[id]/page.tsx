"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { buildDaysFromRange, formatWeekRange } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import type { ScheduleWeekRow, TimeSlotRow, RiderRow, RiderScheduleRow } from "@/lib/types";

type DayCard = {
  date: string;
  shortDate: string;
  weekdayLabel: string;
  isWeekend: boolean;
  isRest: boolean;
  selectedSlotIds: string[];
  selectedCount: number;
  selectableSlots: TimeSlotRow[];
};

const STORAGE_KEY = "offplan.employeeInfo";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

export default function WeekSchedulePage() {
  const params = useParams();
  const weekId = params.id as string;

  const [week, setWeek] = useState<ScheduleWeekRow | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [rider, setRider] = useState<RiderRow | null>(null);
  const [draftName, setDraftName] = useState("");
  const [allSlots, setAllSlots] = useState<TimeSlotRow[]>([]);
  const [schedules, setSchedules] = useState<RiderScheduleRow[]>([]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [allRestCounts, setAllRestCounts] = useState<Record<string, number>>({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showNameGate, setShowNameGate] = useState(false);
  const [pendingRestDay, setPendingRestDay] = useState<DayCard | null>(null);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);

  const selectableSlots = useMemo(() => allSlots.filter((s) => s.is_selectable), [allSlots]);
  const selectableSlotIds = useMemo(() => new Set(selectableSlots.map((s) => s.id)), [selectableSlots]);
  const requiredSlots = week?.required_slots ?? 3;

  const weekDays = useMemo(() => {
    if (!week) return [];
    return buildDaysFromRange(week.start_date, week.end_date);
  }, [week]);

  const currentRestDays = useMemo(() => {
    return schedules.filter((s) => s.slot_id === null).map((s) => s.work_date);
  }, [schedules]);

  const hasRestDay = currentRestDays.length > 0;

  const dayCards = useMemo<DayCard[]>(() => {
    return weekDays.map((day) => {
      const daySchedules = schedules.filter((s) => s.work_date === day.key);
      const isRest = daySchedules.some((s) => s.slot_id === null);
      const selectedSlotIds = daySchedules.filter((s) => s.is_selected === true && s.slot_id !== null).map((s) => s.slot_id!);
      const selectedCount = selectedSlotIds.filter((id) => selectableSlotIds.has(id)).length;

      return {
        date: day.key,
        shortDate: day.shortDate,
        weekdayLabel: day.weekdayLabel,
        isWeekend: day.isWeekend,
        isRest,
        selectedSlotIds,
        selectedCount,
        selectableSlots,
      };
    });
  }, [schedules, weekDays, selectableSlots, selectableSlotIds]);

  useEffect(() => {
    async function loadWeek() {
      setWeekLoading(true);
      const [weekRes, slotsRes] = await Promise.all([
        supabase.from("schedule_weeks").select("*").eq("id", weekId).maybeSingle(),
        supabase.from("time_slots").select("*").eq("week_id", weekId).order("sort_order"),
      ]);
      const weekData = weekRes.data ?? null;
      if (weekData && !weekData.is_active) {
        setMessage("该排休周尚未发布，请联系管理员");
        setWeek(null);
        setAllSlots([]);
      } else {
        setWeek(weekData);
        setAllSlots(slotsRes.data ?? []);
      }
      setWeekLoading(false);
    }
    void loadWeek();
  }, [weekId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const now = Date.now();
        if (parsed?.name && (!parsed.timestamp || now - parsed.timestamp < CACHE_DURATION_MS)) {
          setDraftName(parsed.name);
          setRider(parsed);
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
          setShowNameGate(true);
        }
      }
    } catch {
      // ignore legacy format
    }
    if (!window.localStorage.getItem(STORAGE_KEY)) {
      setShowNameGate(true);
    }
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 2200);
    return () => window.clearTimeout(t);
  }, [message]);

  useEffect(() => {
    if (!week || !rider?.rider_id) {
      setSchedules([]);
      setSchedulesLoaded(false);
      return;
    }
    const curWeek = week;
    const curRider = rider;

    async function load() {
      const [limitsRes, schedRes, restCountsRes] = await Promise.all([
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", curWeek.start_date),
        supabase.from("rider_schedules").select("*").eq("week_id", curWeek.id).eq("rider_id", curRider.rider_id),
        supabase.from("rider_schedules").select("work_date").eq("week_id", curWeek.id).is("slot_id", null),
      ]);

      if (limitsRes.data) {
        setLimits(limitsRes.data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
      }

      setSchedules(schedRes.data ?? []);

      const counts: Record<string, number> = {};
      for (const r of restCountsRes.data ?? []) {
        counts[r.work_date] = (counts[r.work_date] ?? 0) + 1;
      }
      setAllRestCounts(counts);
      setSchedulesLoaded(true);
    }
    void load();
  }, [week, rider]);

  async function refreshRiderSchedules() {
    if (!week || !rider?.rider_id) return;
    const [schedRes, restCountsRes] = await Promise.all([
      supabase.from("rider_schedules").select("*").eq("week_id", week.id).eq("rider_id", rider.rider_id),
      supabase.from("rider_schedules").select("work_date").eq("week_id", week.id).is("slot_id", null),
    ]);
    setSchedules(schedRes.data ?? []);
    const counts: Record<string, number> = {};
    for (const r of restCountsRes.data ?? []) {
      counts[r.work_date] = (counts[r.work_date] ?? 0) + 1;
    }
    setAllRestCounts(counts);
    setSchedulesLoaded(true);
  }

  useEffect(() => {
    const channel = supabase
      .channel(`week-sync-${week?.id ?? "no-week"}-${rider?.rider_id ?? "anon"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rider_schedules", filter: week ? `week_id=eq.${week.id}` : undefined },
        async () => {
          await refreshRiderSchedules();
        })
      .on("postgres_changes", { event: "*", schema: "public", table: "time_slots" }, async () => {
        if (!week) return;
        const { data } = await supabase.from("time_slots").select("*").eq("week_id", week.id).order("sort_order");
        if (data) setAllSlots(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_day_limits", filter: week ? `week_start=eq.${week.start_date}` : undefined },
        async () => {
          if (!week) return;
          const { data } = await supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", week.start_date);
          if (data) setLimits(data.reduce<Record<string, number>>((acc, r) => { acc[r.rest_date] = r.max_slots; return acc; }, {}));
        })
      .on("postgres_changes", { event: "*", schema: "public", table: "riders", filter: rider ? `rider_id=eq.${rider.rider_id}` : undefined },
        async () => {
          if (!rider?.rider_id || !week) return;
          const { data } = await supabase.from("riders").select("*").eq("rider_id", rider.rider_id).eq("week_id", week.id).maybeSingle();
          if (data) setRider(data);
        })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [week, rider]);

  async function saveEmployeeName() {
    const trimmed = draftName.trim();
    if (!trimmed) { setMessage("请填写姓名。"); return; }

    setSubmittingKey("init");
    setMessage(null);

    const { data } = await supabase.from("riders").select("*").eq("week_id", weekId).ilike("name", trimmed).maybeSingle();

    if (!data) {
      setMessage(`"${trimmed}" 不在当前排休周的骑手名单中，请联系管理员。`);
      setSubmittingKey(null);
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rider_id: data.rider_id, name: data.name, timestamp: Date.now() }));
    setRider(data);
    setShowNameGate(false);
    setSubmittingKey(null);
    setMessage(`欢迎，${data.name}`);
  }

  async function handleToggleSlot(workDate: string, slotId: string) {
    if (!week || !rider) return;
    if (submittingKey) return;

    const daySchedule = schedules.filter((s) => s.work_date === workDate && s.slot_id !== null && s.is_selected);
    const currentSelectedIds = daySchedule.map((s) => s.slot_id!) as string[];
    const isAlreadySelected = currentSelectedIds.includes(slotId);

    if (!isAlreadySelected && requiredSlots > 0 && currentSelectedIds.length >= requiredSlots) {
      if (requiredSlots === 1 && currentSelectedIds.length === 1) {
        const [existingSlotId] = currentSelectedIds;
        setSubmittingKey(`slot-${workDate}`);
        setMessage(null);
        const { error: deselectError } = await supabase.rpc("toggle_rider_slot", {
          p_rider_id: rider.rider_id,
          p_week_id: week.id,
          p_work_date: workDate,
          p_slot_id: existingSlotId,
        });
        if (deselectError) {
          setSubmittingKey(null);
          setMessage(deselectError.message);
          await refreshRiderSchedules();
          return;
        }
        const { error: selectError } = await supabase.rpc("toggle_rider_slot", {
          p_rider_id: rider.rider_id,
          p_week_id: week.id,
          p_work_date: workDate,
          p_slot_id: slotId,
        });
        setSubmittingKey(null);
        if (selectError) {
          setMessage(selectError.message);
        }
        await refreshRiderSchedules();
        return;
      }

      setMessage(`每天只能选择 ${requiredSlots} 个时段`);
      return;
    }

    setSubmittingKey(`slot-${workDate}`);
    setMessage(null);

    const { error } = await supabase.rpc("toggle_rider_slot", {
      p_rider_id: rider.rider_id,
      p_week_id: week.id,
      p_work_date: workDate,
      p_slot_id: slotId,
    });

    setSubmittingKey(null);
    if (error) {
      setMessage(error.message);
    }
    await refreshRiderSchedules();
  }

  async function confirmSetRest() {
    if (!week || !rider || !pendingRestDay) return;
    
    // Check if user already has a rest day
    if (hasRestDay && !currentRestDays.includes(pendingRestDay.date)) {
      setMessage("每周只能选择一天排休");
      setPendingRestDay(null);
      return;
    }
    
    setSubmittingKey("rest-" + pendingRestDay.date);
    setMessage(null);

    const { error } = await supabase.rpc("set_rider_rest", {
      p_rider_id: rider.rider_id,
      p_week_id: week.id,
      p_work_date: pendingRestDay.date,
    });

    setSubmittingKey(null);
    setPendingRestDay(null);

    if (error) { setMessage(error.message); return; }
    setMessage("已设为排休");
  }

  if (weekLoading) {
    return (
      <main className="page-container">
        <div className="loading-spinner"><div className="spinner" /><span className="loading-text">加载中...</span></div>
      </main>
    );
  }

  if (!week) {
    return (
      <main className="page-container">
        <header className="page-header"><h1>排班系统</h1><p>该周不存在或已被删除</p></header>
        <div className="empty-state">请联系管理员获取新的排班链接。</div>
      </main>
    );
  }

  return (
    <main className="page-container">
      {pendingRestDay ? (
        <div className="confirm-overlay">
          <section className="confirm-card">
            <h3>{pendingRestDay.weekdayLabel} {pendingRestDay.shortDate} · 确定排休</h3>
            <p className="confirm-copy">确定后将设为排休，当前剩余 <strong>{Math.max(0, (limits[pendingRestDay.date] ?? getDefaultLimit(pendingRestDay.date)) - (allRestCounts[pendingRestDay.date] ?? 0))}</strong> 个排休空位。</p>
            <div className="confirm-actions">
              <button className="btn-secondary" type="button" onClick={() => setPendingRestDay(null)} disabled={submittingKey === "rest-" + pendingRestDay.date}>再想想</button>
              <button className="btn-primary" type="button" onClick={confirmSetRest} disabled={submittingKey === "rest-" + pendingRestDay.date}>
                {submittingKey === "rest-" + pendingRestDay.date ? "提交中..." : "确认"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showNameGate ? (
        <div className="welcome-overlay">
          <section className="welcome-card">
            <h2>填写姓名</h2>
            <p>请输入你的姓名进入排班页面。</p>
            <div className="input-group" style={{ gap: "12px" }}>
              <input className="clean-input" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="姓名" maxLength={20} />
              <button className="btn-primary" type="button" onClick={saveEmployeeName} disabled={submittingKey === "init"}>
                {submittingKey === "init" ? "处理中..." : "进入排班"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <header className="page-header">
        <h1>{rider ? `Hi, ${rider.name}` : "排班系统"}</h1>
        <p>{`${formatWeekRange(week.start_date, week.end_date)} · 已选排休 ${currentRestDays.length}/1 天`}</p>
      </header>

      {message ? <div className="toast-pill">{message}</div> : null}

      {rider && schedulesLoaded ? (
        <section className="calendar-grid">
          {dayCards.map((day) => {
            const remaining = (limits[day.date] ?? getDefaultLimit(day.date)) - (allRestCounts[day.date] ?? 0);
            const isRestFull = remaining <= 0 && !day.isRest;
            const canSelectEnough = requiredSlots === 0 || day.selectedCount === requiredSlots;

            return (
              <article className={`day-card ${day.isWeekend ? "weekend" : ""}`} key={day.date}>
                <div className="card-header">
                  <div className="date-info">
                    <strong>{day.weekdayLabel}</strong>
                    <span>{day.shortDate} · 需选{requiredSlots}个时段</span>
                  </div>
                  <div className={`quota-pill ${remaining <= 0 ? "full" : ""}`}>
                    {remaining > 0 ? `剩余 ${remaining} 排休空位` : "排休人数已满"}
                  </div>
                </div>

                <div className="card-actions">
                  {day.isRest ? (
                    <div className="status-rested">
                      已排休
                    </div>
                  ) : (
                    <>
                      {!canSelectEnough ? (
                        <div style={{ fontSize: "13px", color: "var(--danger-color)", marginBottom: "8px", textAlign: "center" }}>
                          不足！已选{day.selectedCount}个
                        </div>
                      ) : null}

                      {selectableSlots.length > 0 ? (
                        <div className="segment-control">
                          {selectableSlots.map((slot) => {
                            const isSelected = day.selectedSlotIds.includes(slot.id);
                            const isSubmitting = submittingKey === `slot-${day.date}`;
                            return (
                              <button key={slot.id}
                                className={`segment-btn ${isSelected ? "active" : ""}`}
                                type="button"
                                onClick={() => handleToggleSlot(day.date, slot.id)}
                                disabled={isSubmitting}
                                style={{
                                  opacity: isSubmitting ? 0.6 : 1,
                                  cursor: isSubmitting ? "wait" : "pointer",
                                  transition: "all 0.2s ease",
                                }}>
                                {isSubmitting ? "..." : slot.name}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ fontSize: "13px", color: "var(--text-muted)", textAlign: "center", padding: "12px 0" }}>
                          暂无可选时段
                        </div>
                      )}

                      <button className="btn-rest" type="button"
                        disabled={isRestFull || (hasRestDay && !day.isRest) || submittingKey !== null}
                        onClick={() => setPendingRestDay(day)}>
                        {isRestFull ? "排休人数已满" : (hasRestDay && !day.isRest) ? "已选排休" : "申请排休"}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      ) : rider ? (
        <div className="empty-state">加载排班数据中...</div>
      ) : null}
    </main>
  );
}
