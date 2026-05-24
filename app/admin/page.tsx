"use client";

import { useEffect, useMemo, useState } from "react";
import { buildDaysFromRange, formatWeekRange } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import type { EmployeeWeekShiftRow, RestPeriodRow, RestWeekRow, RestWeekMemberRow } from "@/lib/types";

const DEFAULT_WEEKDAY_LIMIT = 5;
const DEFAULT_WEEKEND_LIMIT = 2;

function getDefaultLimit(date: string) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6 ? DEFAULT_WEEKEND_LIMIT : DEFAULT_WEEKDAY_LIMIT;
}

function formatPeriodLabel(period: RestPeriodRow) {
  return `${period.name} ${period.start_time.slice(0, 5)}-${period.end_time.slice(0, 5)}`;
}

function createDraftPeriod(sortOrder: number): RestPeriodRow {
  return {
    id: `draft-${crypto.randomUUID()}`,
    name: "",
    start_time: "10:30:00",
    end_time: "13:30:00",
    sort_order: sortOrder,
    is_active: true,
  };
}

function createDraftWeek(): RestWeekRow {
  return {
    id: `draft-${crypto.randomUUID()}`,
    start_date: "",
    end_date: "",
    is_active: false,
    default_period_id: null,
  };
}

export default function AdminPage() {
  const [weeks, setWeeks] = useState<RestWeekRow[]>([]);
  const [activeWeek, setActiveWeek] = useState<RestWeekRow | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [shifts, setShifts] = useState<EmployeeWeekShiftRow[]>([]);
  const [periods, setPeriods] = useState<RestPeriodRow[]>([]);
  const [savingDate, setSavingDate] = useState<string | null>(null);
  const [savingPeriodId, setSavingPeriodId] = useState<string | null>(null);
  const [savingWeekId, setSavingWeekId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [weekMembers, setWeekMembers] = useState<Record<string, string>>({});
  const [editingMemberWeekId, setEditingMemberWeekId] = useState<string | null>(null);
  const [draftMemberText, setDraftMemberText] = useState("");


  const weekDays = useMemo(() => {
    if (!activeWeek) return [];
    return buildDaysFromRange(activeWeek.start_date, activeWeek.end_date);
  }, [activeWeek]);

  const periodMap = useMemo(
    () =>
      periods.reduce<Record<string, RestPeriodRow>>((acc, item) => {
        acc[item.id] = item;
        return acc;
      }, {}),
    [periods],
  );

  const requestSummaries = useMemo(() => {
    const grouped = new Map<string, EmployeeWeekShiftRow[]>();

    for (const shift of shifts) {
      const key = shift.employee_name;
      const list = grouped.get(key) ?? [];
      list.push(shift);
      grouped.set(key, list);
    }

    return Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
      .map(([employeeName, employeeShifts]) => {
        const shiftsByDate = new Map(employeeShifts.map((item) => [item.work_date, item]));
        const weekSummary = weekDays.map((day) => {
          const shift = shiftsByDate.get(day.key);

          if (!shift) {
            return `${day.weekdayLabel} 未生成`;
          }

          if (shift.status === "rest") {
            return `${day.weekdayLabel} 排休`;
          }

          return `${day.weekdayLabel} ${
            periodMap[shift.period_id ?? ""] ? periodMap[shift.period_id ?? ""].name : "未设时段"
          }`;
        });

        return {
          employeeName,
          dayTexts: weekSummary,
        };
      });
  }, [periodMap, shifts, weekDays]);

  // =============== 以下所有的 useEffect 和 方法逻辑 一行未动 ===============

  useEffect(() => {
    async function loadData() {
      const [weeksResponse, periodsResponse, membersResponse] = await Promise.all([
        supabase.from("rest_weeks").select("id,start_date,end_date,is_active,default_period_id").order("start_date", { ascending: false }),
        supabase.from("rest_periods").select("id,name,start_time,end_time,sort_order,is_active").order("sort_order", { ascending: true }),
        supabase.from("rest_week_members").select("week_id,members"),
      ]);
      if (weeksResponse.data) {
        setWeeks(weeksResponse.data);
        setActiveWeek(weeksResponse.data.find((item) => item.is_active) ?? weeksResponse.data[0] ?? null);
      }
      if (periodsResponse.data) {
        setPeriods(periodsResponse.data);
      }
      if (membersResponse.data) {
        setWeekMembers(membersResponse.data.reduce<Record<string, string>>((acc, row) => {
          acc[row.week_id] = row.members;
          return acc;
        }, {}));
      }
    }
    void loadData();
  }, []);

  useEffect(() => {
    if (!activeWeek) {
      setShifts([]);
      setLimits({});
      return;
    }
    const weekStart = activeWeek.start_date;
    async function loadWeekData() {
      const [limitsResponse, shiftsResponse] = await Promise.all([
        supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", weekStart),
        supabase.from("employee_week_shifts").select("id,week_start,work_date,employee_name,status,period_id,created_at,updated_at").eq("week_start", weekStart).order("employee_name", { ascending: true }).order("work_date", { ascending: true }),
      ]);
      const nextLimits = (limitsResponse.data ?? []).reduce<Record<string, number>>((acc, row) => {
        acc[row.rest_date] = row.max_slots;
        return acc;
      }, {});
      setLimits(nextLimits);
      setShifts(shiftsResponse.data ?? []);
    }
    void loadWeekData();
  }, [activeWeek]);

  useEffect(() => {
    const channel = supabase
      .channel(`admin-sync-${activeWeek?.start_date ?? "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_weeks" }, async () => {
        const { data } = await supabase.from("rest_weeks").select("id,start_date,end_date,is_active,default_period_id").order("start_date", { ascending: false });
        if (data) {
          setWeeks(data);
          setActiveWeek((current) => {
            if (!current) return data.find((item) => item.is_active) ?? data[0] ?? null;
            return data.find((item) => item.id === current.id) ?? data.find((item) => item.is_active) ?? data[0] ?? null;
          });
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_periods" }, async () => {
        const { data } = await supabase.from("rest_periods").select("id,name,start_time,end_time,sort_order,is_active").order("sort_order", { ascending: true });
        if (data) setPeriods(data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_day_limits", filter: activeWeek ? `week_start=eq.${activeWeek.start_date}` : undefined }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("rest_day_limits").select("rest_date,max_slots").eq("week_start", activeWeek.start_date);
        const nextLimits = (data ?? []).reduce<Record<string, number>>((acc, row) => {
          acc[row.rest_date] = row.max_slots;
          return acc;
        }, {});
        setLimits(nextLimits);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "employee_week_shifts", filter: activeWeek ? `week_start=eq.${activeWeek.start_date}` : undefined }, async () => {
        if (!activeWeek) return;
        const { data } = await supabase.from("employee_week_shifts").select("id,week_start,work_date,employee_name,status,period_id,created_at,updated_at").eq("week_start", activeWeek.start_date).order("employee_name", { ascending: true }).order("work_date", { ascending: true });
        setShifts(data ?? []);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rest_week_members" }, async () => {
        const { data } = await supabase.from("rest_week_members").select("week_id,members");
        if (data) {
          setWeekMembers(data.reduce<Record<string, string>>((acc, row) => {
            acc[row.week_id] = row.members;
            return acc;
          }, {}));
        }
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeWeek]);

  async function saveWeek(week: RestWeekRow) {
    if (!week.start_date || !week.end_date) {
      setMessage("请完整填写起止日期。");
      return;
    }
    setSavingWeekId(week.id);
    setMessage(null);

    if (week.is_active) {
      await supabase.from("rest_weeks").update({ is_active: false }).eq("is_active", true);
    }
    const payload = {
      ...(week.id.startsWith("draft-") ? {} : { id: week.id }),
      start_date: week.start_date,
      end_date: week.end_date,
      is_active: week.is_active,
      default_period_id: week.default_period_id,
    };
    const { error } = await supabase.from("rest_weeks").upsert(payload);

    if (error) {
      setSavingWeekId(null);
      setMessage(error.message);
      return;
    }

    if (week.id.startsWith("draft-")) {
      setWeeks((current) => current.filter((item) => item.id !== week.id));
    }

    // 一并保存周名单
    if (editingMemberWeekId === week.id) {
      const { error: memberError } = await supabase.from("rest_week_members").upsert(
        { week_id: week.id, members: draftMemberText },
        { onConflict: "week_id" },
      );
      if (memberError) {
        setSavingWeekId(null);
        setMessage(memberError.message);
        return;
      }
      setWeekMembers((prev) => ({ ...prev, [week.id]: draftMemberText }));
      setEditingMemberWeekId(null);
    }

    setSavingWeekId(null);
    setMessage("排休周已保存。");
  }

  async function deleteWeek(weekId: string) {
    setSavingWeekId(weekId);
    setMessage(null);
    if (weekId.startsWith("draft-")) {
      setWeeks((current) => current.filter((item) => item.id !== weekId));
      setWeekMembers((prev) => { const next = { ...prev }; delete next[weekId]; return next; });
      setSavingWeekId(null);
      return;
    }
    const { error } = await supabase.from("rest_weeks").delete().eq("id", weekId);
    setSavingWeekId(null);
    if (error) {
      setMessage(error.message);
      return;
    }
    setWeekMembers((prev) => { const next = { ...prev }; delete next[weekId]; return next; });
    setMessage("排休周已删除。");
  }

  async function savePeriod(period: RestPeriodRow) {
    if (!period.name.trim()) {
      setMessage("时段名称不能为空。");
      return;
    }
    setSavingPeriodId(period.id);
    setMessage(null);

    const payload = {
      ...(period.id.startsWith("draft-") ? {} : { id: period.id }),
      name: period.name.trim(),
      start_time: period.start_time,
      end_time: period.end_time,
      sort_order: period.sort_order,
      is_active: period.is_active,
    };
    const { error } = await supabase.from("rest_periods").upsert(payload);
    setSavingPeriodId(null);

    if (error) {
      setMessage(error.message);
      return;
    }
    if (period.id.startsWith("draft-")) {
      setPeriods((current) => current.filter((item) => item.id !== period.id));
    }
    setMessage("时段已保存。");
  }

  async function deletePeriod(periodId: string) {
    setSavingPeriodId(periodId);
    setMessage(null);
    if (periodId.startsWith("draft-")) {
      setPeriods((current) => current.filter((item) => item.id !== periodId));
      setSavingPeriodId(null);
      return;
    }
    const { error } = await supabase.from("rest_periods").delete().eq("id", periodId);
    setSavingPeriodId(null);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("时段已删除。");
  }

  async function saveLimit(restDate: string) {
    if (!activeWeek) return;
    setSavingDate(restDate);
    setMessage(null);

    const maxSlots = limits[restDate] ?? getDefaultLimit(restDate);
    const { error } = await supabase.from("rest_day_limits").upsert(
      { week_start: activeWeek.start_date, rest_date: restDate, max_slots: maxSlots },
      { onConflict: "week_start,rest_date" },
    );
    setSavingDate(null);

    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(`已保存 ${restDate} 的名额。`);
  }

  // 自动消除消息的副作用
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 2500);
    return () => window.clearTimeout(timer);
  }, [message]);

  return (
    <main className="page-container">
      <header className="page-header">
        <h1>后台管理</h1>
        <p>控制班次时间、开放周与查看整体排班</p>
      </header>

      {message ? <div className="toast-pill">{message}</div> : null}

      {/* 排休周配置 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>排休周配置</h2>
            <p>启用周决定员工端展示哪一周</p>
          </div>
          <button className="btn-primary btn-sm" type="button" onClick={() => setWeeks((current) => [createDraftWeek(), ...current])}>
            + 新增一周
          </button>
        </div>

        <div className="config-grid">
          {weeks.map((week) => (
            <div className={`config-card ${week.is_active ? "active-card" : ""}`} key={week.id}>
              <div className="input-group">
                <input type="date" className="clean-input" value={week.start_date} onChange={(event) => setWeeks((current) => current.map((item) => item.id === week.id ? { ...item, start_date: event.target.value } : item))} />
                <input type="date" className="clean-input" value={week.end_date} onChange={(event) => setWeeks((current) => current.map((item) => item.id === week.id ? { ...item, end_date: event.target.value } : item))} />
                <select className="clean-input" value={week.default_period_id ?? ""} onChange={(event) => setWeeks((current) => current.map((item) => item.id === week.id ? { ...item, default_period_id: event.target.value || null } : item))}>
                  <option value="">选择默认班次</option>
                  {periods.filter((item) => item.is_active).map((period) => (
                    <option key={period.id} value={period.id}>{period.name}</option>
                  ))}
                </select>
                <label className="switch-label">
                  <input type="checkbox" checked={week.is_active} onChange={(event) => {
                    const checked = event.target.checked;
                    setWeeks((current) => current.map((item) => ({
                      ...item,
                      is_active: item.id === week.id ? checked : checked ? false : item.is_active,
                    })));
                    if (checked) setActiveWeek(week);
                  }} />
                  设为当前启用周
                </label>
              </div>

              {/* 周名单 */}
              {editingMemberWeekId === week.id ? (
                <div className="member-editor">
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-muted)" }}>本周人员名单（以空格分隔）</label>
                  <textarea
                    className="member-textarea"
                    rows={3}
                    value={draftMemberText}
                    onChange={(event) => setDraftMemberText(event.target.value)}
                    placeholder="张三 李四 王五"
                  />
                  <div className="card-actions-row">
                    <button className="btn-ghost btn-sm" type="button" onClick={() => setEditingMemberWeekId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="member-summary">
                  <span className="member-count">
                    {weekMembers[week.id]
                      ? `${weekMembers[week.id].split(/\s+/).filter(Boolean).length} 人`
                      : "未设置名单"}
                  </span>
                  <button className="btn-ghost btn-sm" type="button" onClick={() => {
                    setDraftMemberText(weekMembers[week.id] ?? "");
                    setEditingMemberWeekId(week.id);
                  }}>
                    编辑本周人员名单
                  </button>
                </div>
              )}

              <div className="card-actions-row">
                <button className="btn-primary btn-sm" type="button" disabled={savingWeekId === week.id} onClick={() => saveWeek(week)}>
                  保存
                </button>
                <button className="btn-ghost btn-sm" type="button" disabled={savingWeekId === week.id} onClick={() => deleteWeek(week.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 当前周排班总览 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>当前周排班总览</h2>
            <p>{activeWeek ? formatWeekRange(activeWeek.start_date, activeWeek.end_date) : "未选择排休周"}</p>
          </div>
        </div>

        {/* 周名单显示 */}
        {activeWeek && weekMembers[activeWeek.id] ? (
          <div className="member-tags">
            {weekMembers[activeWeek.id].split(/\s+/).filter(Boolean).map((name) => (
              <span key={name} className="member-tag">{name}</span>
            ))}
          </div>
        ) : activeWeek ? (
          <p style={{ fontSize: "14px", color: "var(--text-muted)", margin: "0 0 16px" }}>该周尚未设置人员名单</p>
        ) : null}

        {requestSummaries.length > 0 ? (
          <div className="table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>员工姓名 ({requestSummaries.length}人)</th>
                  {weekDays.map(day => (
                    <th key={day.key}>{day.weekdayLabel} <br/><span style={{fontSize: "12px", fontWeight: "normal"}}>{day.shortDate}</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requestSummaries.map((item) => (
                  <tr key={item.employeeName}>
                    <td>{item.employeeName}</td>
                    {item.dayTexts.map((text, i) => {
                      const stateText = text.substring(text.indexOf(" ") + 1);
                      let badgeClass = "work";
                      if (stateText === "排休") badgeClass = "rest";
                      if (stateText === "未生成") badgeClass = "missing";
                      return (
                        <td key={`${item.employeeName}-${i}`}>
                          <span className={`status-badge ${badgeClass}`}>{stateText}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">当前周还没有员工生成班次</div>
        )}
      </section>

      {/* 时段配置 */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>时段配置</h2>
            <p>维护所有可选的上班时段</p>
          </div>
          <button className="btn-primary btn-sm" type="button" onClick={() => setPeriods((current) => [...current, createDraftPeriod(current.length + 1)])}>
            + 新增时段
          </button>
        </div>

        <div className="config-grid">
          {periods.slice().sort((a, b) => a.sort_order - b.sort_order).map((period) => (
            <div className="config-card" key={period.id}>
              <div className="input-group">
                <input className="clean-input" value={period.name} onChange={(event) => setPeriods((current) => current.map((item) => item.id === period.id ? { ...item, name: event.target.value } : item))} placeholder="时段名称 (如: 早班)" />
                <input type="time" className="clean-input" value={period.start_time.slice(0, 5)} onChange={(event) => setPeriods((current) => current.map((item) => item.id === period.id ? { ...item, start_time: `${event.target.value}:00` } : item))} />
                <input type="time" className="clean-input" value={period.end_time.slice(0, 5)} onChange={(event) => setPeriods((current) => current.map((item) => item.id === period.id ? { ...item, end_time: `${event.target.value}:00` } : item))} />
                <input type="number" className="clean-input" min={0} value={period.sort_order} onChange={(event) => setPeriods((current) => current.map((item) => item.id === period.id ? { ...item, sort_order: Number(event.target.value) } : item))} placeholder="排序序号" />
                <label className="switch-label">
                  <input type="checkbox" checked={period.is_active} onChange={(event) => setPeriods((current) => current.map((item) => item.id === period.id ? { ...item, is_active: event.target.checked } : item))} />
                  启用时段
                </label>
              </div>
              <div className="card-actions-row">
                <button className="btn-primary btn-sm" type="button" disabled={savingPeriodId === period.id} onClick={() => savePeriod(period)}>保存</button>
                <button className="btn-ghost btn-sm" type="button" disabled={savingPeriodId === period.id} onClick={() => deletePeriod(period.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 核心改动：每日排休名额设置（改造成类似配置卡片的自适应网格） */}
      <section className="admin-section">
        <div className="section-header">
          <div>
            <h2>每日休息名额配额</h2>
            <p>控制本周各天允许的最多休息人数</p>
          </div>
        </div>

        <div className="config-grid">
          {weekDays.map((day) => {
            const usedSlots = shifts.filter((item) => item.work_date === day.key && item.status === "rest").length;
            const maxSlots = limits[day.key] ?? getDefaultLimit(day.key);

            return (
              <div className="config-card" key={day.key} style={{ flexDirection: "row", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <strong style={{ display: "block", fontSize: "16px" }}>{day.weekdayLabel}</strong>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{day.shortDate} · 已用 {usedSlots} 人</span>
                </div>
                <div style={{ width: "80px" }}>
                  <input className="clean-input" type="number" min={0} max={20} value={maxSlots} onChange={(event) => setLimits((current) => ({ ...current, [day.key]: Number(event.target.value) }))} style={{ padding: "8px", textAlign: "center" }} />
                </div>
                <button className="btn-primary btn-sm" type="button" disabled={savingDate === day.key} onClick={() => saveLimit(day.key)} style={{ whiteSpace: "nowrap" }}>
                  保存
                </button>
              </div>
            );
          })}
        </div>
      </section>

    </main>
  );
}