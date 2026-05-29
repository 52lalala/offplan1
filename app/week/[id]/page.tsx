"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { buildDaysFromRange, formatWeekRange } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import type { EmployeeWeekShiftRow, RestPeriodRow, RestWeekRow } from "@/lib/types";

type DayCard = {
  date: string;
  shortDate: string;
  weekdayLabel: string;
  maxSlots: number;
  remainingSlots: number;
  isRest: boolean;
  isWeekend: boolean;
  selectedPeriodIds: string[];
};

const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;
const STORAGE_KEY = "offplan.employeeName";

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

export default function WeekSchedulePage() {
  const params = useParams();
  const weekId = params.id as string;

  const [week, setWeek] = useState<RestWeekRow | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [employeeName, setEmployeeName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [dayLimits, setDayLimits] = useState<Record<string, number>>({});
  const [shifts, setShifts] = useState<EmployeeWeekShiftRow[]>([]);
  const [periods, setPeriods] = useState<RestPeriodRow[]>([]);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [togglingPeriods, setTogglingPeriods] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showNameGate, setShowNameGate] = useState(false);
  const [pendingRestDay, setPendingRestDay] = useState<DayCard | null>(null);
  const [activeWeekMembers, setActiveWeekMembers] = useState<string[] | null>(null);
  const [allRestCounts, setAllRestCounts] = useState<Record<string, number>>({});
  const [shiftsLoaded, setShiftsLoaded] = useState(false);

  const weekDays = useMemo(() => {
    if (!week) return [];
    return buildDaysFromRange(week.start_date, week.end_date);
  }, [week]);

  const sortedPeriods = useMemo(
    () => periods.slice().sort((a, b) => a.sort_order - b.sort_order),
    [periods],
  );

  const maxSelectable = useMemo(
    () => periods.filter((p) => p.is_active).length,
    [periods],
  );

  const myRestDay = useMemo(() => shifts.find((item) => item.period_id === null), [shifts]);

  const dayCards = useMemo<DayCard[]>(() => {
    return weekDays.map((day) => {
      const usedSlots = allRestCounts[day.key] ?? 0;
      const dayShifts = shifts.filter((item) => item.work_date === day.key);
      const maxSlots = dayLimits[day.key] ?? getDefaultLimit(day.key);

      return {
        date: day.key,
        shortDate: day.shortDate,
        weekdayLabel: day.weekdayLabel,
        maxSlots,
        remainingSlots: Math.max(0, maxSlots - usedSlots),
        isRest: dayShifts.some((s) => s.period_id === null),
        isWeekend: day.isWeekend,
        selectedPeriodIds: dayShifts.filter((s) => s.period_id !== null).map((s) => s.period_id!),
      };
    });
  }, [allRestCounts, dayLimits, shifts, weekDays]);

  useEffect(() => {
    async function loadWeek() {
      setWeekLoading(true);
      const [weekResponse, periodsResponse] = await Promise.all([
        supabase
          .from("rest_weeks")
          .select("id,start_date,end_date,is_active")
          .eq("id", weekId)
          .maybeSingle(),
        supabase
          .from("rest_periods")
          .select("id,name,start_time,end_time,sort_order,is_active,week_id")
          .eq("week_id", weekId),
      ]);
      setWeek(weekResponse.data ?? null);
      setPeriods(periodsResponse.data ?? []);
      setWeekLoading(false);
    }
    void loadWeek();
  }, [weekId]);

  useEffect(() => {
    const storedName = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
    if (storedName) {
      setEmployeeName(storedName);
      setDraftName(storedName);
    } else {
      setShowNameGate(true);
    }
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 2200);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!week) {
      setActiveWeekMembers(null);
      return;
    }
    const currentWeek = week;
    async function fetchMembers() {
      const { data } = await supabase
        .from("rest_week_members")
        .select("members")
        .eq("week_id", currentWeek.id)
        .maybeSingle();
      if (data?.members?.trim()) {
        const members = data.members.split(/\s+/).filter(Boolean);
        setActiveWeekMembers(members);
        const storedName = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
        if (storedName && !members.includes(storedName)) {
          setEmployeeName("");
          setDraftName("");
          setShowNameGate(true);
        }
      } else {
        setActiveWeekMembers(null);
        const storedName = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
        if (storedName) {
          setEmployeeName("");
          setDraftName("");
          setShowNameGate(true);
        }
      }
    }
    void fetchMembers();
  }, [week]);

  useEffect(() => {
    async function fetchMyShifts() {
      if (!week || !employeeName.trim()) {
        setShifts([]);
        return;
      }

      await supabase.rpc("init_employee_week_shifts", {
        p_week_start: week.start_date,
        p_employee_name: employeeName.trim(),
      });

      const [limitsResponse, shiftsResponse, restCountsResponse] = await Promise.all([
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", week.start_date),
        supabase
          .from("employee_week_shifts")
          .select("id,week_start,work_date,employee_name,period_id,created_at,updated_at")
          .eq("week_start", week.start_date)
          .eq("employee_name", employeeName.trim())
          .order("work_date", { ascending: true }),
        supabase
          .from("employee_week_shifts")
          .select("work_date")
          .eq("week_start", week.start_date)
          .is("period_id", null),
      ]);

      if (limitsResponse.data) {
        const nextLimits = limitsResponse.data.reduce<Record<string, number>>((acc, row) => {
          acc[row.rest_date] = row.max_slots;
          return acc;
        }, {});
        setDayLimits(nextLimits);
      }

      setShifts(shiftsResponse.data ?? []);

      const nextRestCounts: Record<string, number> = {};
      for (const row of restCountsResponse.data ?? []) {
        nextRestCounts[row.work_date] = (nextRestCounts[row.work_date] ?? 0) + 1;
      }
      setAllRestCounts(nextRestCounts);
      setShiftsLoaded(true);
    }

    void fetchMyShifts();
  }, [week, employeeName]);

  useEffect(() => {
    const channel = supabase
      .channel(`week-sync-${week?.start_date ?? "no-week"}-${employeeName || "anon"}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "employee_week_shifts",
          filter: week && employeeName ? `week_start=eq.${week.start_date}` : undefined,
        },
        async (_payload: RealtimePostgresChangesPayload<EmployeeWeekShiftRow>) => {
          if (!week || !employeeName.trim()) return;

          const [shiftsResponse, restCountsResponse] = await Promise.all([
            supabase
              .from("employee_week_shifts")
              .select("id,week_start,work_date,employee_name,period_id,created_at,updated_at")
              .eq("week_start", week.start_date)
              .eq("employee_name", employeeName.trim())
              .order("work_date", { ascending: true }),
            supabase
              .from("employee_week_shifts")
              .select("work_date")
              .eq("week_start", week.start_date)
              .is("period_id", null),
          ]);

          setShifts(shiftsResponse.data ?? []);

          const nextRestCounts: Record<string, number> = {};
          for (const row of restCountsResponse.data ?? []) {
            nextRestCounts[row.work_date] = (nextRestCounts[row.work_date] ?? 0) + 1;
          }
          setAllRestCounts(nextRestCounts);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rest_day_limits",
          filter: week ? `week_start=eq.${week.start_date}` : undefined,
        },
        async () => {
          if (!week) return;

          const { data } = await supabase
            .from("rest_day_limits")
            .select("rest_date,max_slots")
            .eq("week_start", week.start_date);

          const nextLimits = (data ?? []).reduce<Record<string, number>>((acc, row) => {
            acc[row.rest_date] = row.max_slots;
            return acc;
          }, {});

          setDayLimits(nextLimits);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rest_week_members",
        },
        async () => {
          if (!week) return;
          const { data } = await supabase
            .from("rest_week_members")
            .select("members")
            .eq("week_id", week.id)
            .maybeSingle();
          if (data?.members?.trim()) {
            setActiveWeekMembers(data.members.split(/\s+/).filter(Boolean));
          } else {
            setActiveWeekMembers(null);
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [week, employeeName]);

  async function initializeWeekShifts(nextName: string) {
    if (!week) {
      setMessage("该排休周不存在。");
      return false;
    }

    const { data, error } = await supabase.rpc("init_employee_week_shifts", {
      p_week_start: week.start_date,
      p_employee_name: nextName,
    });

    if (error) {
      setMessage(error.message);
      return false;
    }

    if (!data?.success) {
      setMessage(data?.message ?? "初始化本周班次失败。");
      return false;
    }

    return true;
  }

  async function saveEmployeeName() {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setMessage("请先填写姓名。");
      return;
    }

    if (activeWeekMembers === null || !activeWeekMembers.includes(trimmedName)) {
      setMessage(activeWeekMembers === null ? "当前周尚未设置人员名单，请联系管理员。" : `"${trimmedName}" 不在当前周的人员名单中，请联系管理员。`);
      return;
    }

    setSubmittingKey("init");
    const initialized = await initializeWeekShifts(trimmedName);
    setSubmittingKey(null);

    if (!initialized) return;

    window.localStorage.setItem(STORAGE_KEY, trimmedName);
    setEmployeeName(trimmedName);
    setDraftName(trimmedName);
    setShowNameGate(false);
    setMessage(`欢迎，${trimmedName}`);
  }

  function openRestConfirm(workDate: string) {
    if (!week || !employeeName.trim()) {
      setMessage("请先确认姓名。");
      return;
    }

    const card = dayCards.find((item) => item.date === workDate);
    if (!card) return;
    setPendingRestDay(card);
  }

  async function confirmSetRest() {
    if (!week || !employeeName.trim() || !pendingRestDay) return;

    setSubmittingKey(pendingRestDay.date);
    setMessage(null);

    const { data, error } = await supabase.rpc("set_employee_rest", {
      p_week_start: week.start_date,
      p_work_date: pendingRestDay.date,
      p_employee_name: employeeName.trim(),
    });

    setSubmittingKey(null);
    setPendingRestDay(null);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(data?.message ?? "已设为排休。");
    await refetchMyShifts();
  }

  async function refetchMyShifts() {
    if (!week || !employeeName.trim()) {
      setShifts([]);
      return;
    }
    const { data } = await supabase
      .from("employee_week_shifts")
      .select("id,week_start,work_date,employee_name,period_id,created_at,updated_at")
      .eq("week_start", week.start_date)
      .eq("employee_name", employeeName.trim())
      .order("work_date", { ascending: true });
    setShifts(data ?? []);
  }

  async function handleTogglePeriod(workDate: string, periodId: string) {
    if (!week || !employeeName.trim()) {
      setMessage("请先确认姓名。");
      return;
    }

    const key = `${workDate}-${periodId}`;
    if (togglingPeriods[key]) return;

    setTogglingPeriods((prev) => ({ ...prev, [key]: true }));
    setMessage(null);

    // Optimistic: 立即翻转选中状态
    setShifts((prev) => {
      const exists = prev.find((s) => s.work_date === workDate && s.period_id === periodId);
      if (exists) {
        return prev.filter((s) => s !== exists);
      }
      const dummy = { id: "opt-" + periodId, week_start: week.start_date, work_date: workDate, employee_name: employeeName.trim(), period_id: periodId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      return [...prev.filter((s) => s.work_date !== workDate || s.period_id === null), dummy];
    });

    const { data, error } = await supabase.rpc("toggle_employee_period", {
      p_week_start: week.start_date,
      p_work_date: workDate,
      p_employee_name: employeeName.trim(),
      p_period_id: periodId,
    });

    if (error) {
      setMessage(error.message);
      await refetchMyShifts();
      setTogglingPeriods((prev) => ({ ...prev, [key]: false }));
      return;
    }

    await refetchMyShifts();
    setTogglingPeriods((prev) => ({ ...prev, [key]: false }));
  }

  if (weekLoading) {
    return (
      <main className="page-container">
        <div className="loading-spinner">
          <div className="spinner" />
          <span className="loading-text">加载中...</span>
        </div>
      </main>
    );
  }

  if (!week) {
    return (
      <main className="page-container">
        <header className="page-header">
          <h1>排班系统</h1>
          <p>该排休周不存在或已被删除</p>
        </header>
        <div className="empty-state">
          请联系管理员获取新的排休周链接。
        </div>
      </main>
    );
  }

  return (
    <main className="page-container">
      {pendingRestDay ? (
        <div className="confirm-overlay">
          <section className="confirm-card">
            <p className="confirm-eyebrow">确认排休</p>
            <h3>
              {pendingRestDay.weekdayLabel} {pendingRestDay.shortDate}
            </h3>
            <p className="confirm-copy">确定后将设为排休，当前剩余 <strong>{pendingRestDay.remainingSlots}</strong> 个排休空位，提交后不可修改。</p>
            <div className="confirm-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setPendingRestDay(null)}
                disabled={submittingKey === pendingRestDay.date}
              >
                再想想
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={confirmSetRest}
                disabled={submittingKey === pendingRestDay.date}
              >
                {submittingKey === pendingRestDay.date ? "提交中..." : "确定排休"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showNameGate ? (
        <div className="welcome-overlay">
          <section className="welcome-card">
            <h2>填写姓名</h2>
            <p>请填写真实姓名后进入排休页面，系统会自动生成当前周默认班次。</p>
            <div className="input-group">
              <input
                className="clean-input"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="例如：张三"
                maxLength={20}
              />
              <button
                className="btn-primary"
                type="button"
                onClick={saveEmployeeName}
                disabled={submittingKey === "init"}
              >
                {submittingKey === "init" ? "处理中..." : "进入排班"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <header className="page-header">
        <h1>{employeeName ? `Hi, ${employeeName}` : "排班系统"}</h1>
        <p>{`本周范围：${formatWeekRange(week.start_date, week.end_date)}`}</p>
      </header>

      {message ? <div className="toast-pill">{message}</div> : null}

      <section className="calendar-grid">
        {dayCards.map((day) => {
          const hasRestOnOtherDay = myRestDay !== undefined && myRestDay.work_date !== day.date && !day.isRest;
          const isRestFull = day.remainingSlots === 0 && !day.isRest;

          return (
            <article className={`day-card ${day.isWeekend ? "weekend" : ""}`} key={day.date}>
              <div className="card-header">
                <div className="date-info">
                  <strong>{day.weekdayLabel}</strong>
                  <span>{day.shortDate}</span>
                </div>
                <div className={`quota-pill ${day.remainingSlots === 0 ? "full" : ""}`}>
                  {day.remainingSlots > 0 ? `剩余 ${day.remainingSlots} 排休空位` : "排休人数已满"}
                </div>
              </div>

              <div className="card-actions">
                {day.isRest ? (
                  <div className="status-rested">已设为排休</div>
                ) : (
                  <>
                    <div className="segment-control">
                      {sortedPeriods.map((period) => {
                        const isSelected = day.selectedPeriodIds.includes(period.id);
                        return (
                          <button
                            key={period.id}
                            style={{ WebkitTapHighlightColor: "transparent" }} /* 消除移动端点击闪烁问题 */
                            className={`segment-btn ${isSelected ? "active" : ""}`}
                            type="button"
                            onClick={() => handleTogglePeriod(day.date, period.id)}
                          >
                            {period.name}
                          </button>
                        );
                      })}
                    </div>
                    {shiftsLoaded ? (
                      <button
                        className="btn-rest"
                        type="button"
                        disabled={!week || isRestFull || hasRestOnOtherDay || submittingKey !== null}
                        onClick={() => openRestConfirm(day.date)}
                      >
                        {hasRestOnOtherDay ? "本周已排休" : isRestFull ? "排休人数已满" : "申请排休"}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}