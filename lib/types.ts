export type RestWeekRow = {
  id: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
};

export type RestPeriodRow = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  sort_order: number;
  is_active: boolean;
  week_id: string;
};

export type DayLimitRow = {
  rest_date: string;
  max_slots: number;
};

export type RestWeekMemberRow = {
  id: string;
  week_id: string;
  members: string;
  created_at: string;
  updated_at: string;
};

export type EmployeeWeekShiftRow = {
  id: string;
  week_start: string;
  work_date: string;
  employee_name: string;
  period_id: string | null;
  created_at: string;
  updated_at: string;
};
