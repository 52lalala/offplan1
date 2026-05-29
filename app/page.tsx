"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatWeekRange } from "@/lib/date";
import { supabase } from "@/lib/supabase";
import type { RestWeekRow } from "@/lib/types";

export default function HomePage() {
  const router = useRouter();
  const [weeks, setWeeks] = useState<RestWeekRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("rest_weeks")
        .select("id,start_date,end_date,is_active")
        .eq("is_active", true)
        .order("start_date", { ascending: false });
      const list = data ?? [];
      setWeeks(list);
      setLoading(false);

      if (list.length === 1) {
        router.replace(`/week/${list[0].id}`);
      }
    }
    void load();
  }, [router]);

  return (
    <main className="page-container">
      <header className="page-header">
        <h1>排班系统</h1>
        <p>请选择你要查看的排休周</p>
      </header>

      {loading ? (
        <div className="empty-state">数据加载中...</div>
      ) : weeks.length === 0 ? (
        <div className="empty-state">暂无开放的排休周，请联系管理员。</div>
      ) : (
        <div className="config-grid">
          {weeks.map((week) => (
            <div className="config-card" key={week.id}>
              <div className="input-group">
                <strong style={{ fontSize: "16px" }}>{formatWeekRange(week.start_date, week.end_date)}</strong>
                <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                  {week.start_date} ~ {week.end_date}
                </span>
              </div>
              <div className="card-actions-row" style={{ marginTop: "12px" }}>
                <button
                  className="btn-primary btn-sm"
                  type="button"
                  onClick={() => { router.push(`/week/${week.id}`); }}
                >
                  进入排班
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
