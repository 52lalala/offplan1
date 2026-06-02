export type ScheduleWeekRow = {
  id: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
};

export type TimeSlotRow = {
  id: string;
  week_id: string;
  name: string;
  start_time: string;
  end_time: string;
  sort_order: number;
  is_selectable: boolean;
  is_active: boolean;
};

export type RiderRow = {
  rider_id: string;
  name: string;
  group_id: string;
  group_name: string;
  rider_type: string;
  min_slots: number;
  is_active: boolean;
};

export type RestDayLimitRow = {
  rest_date: string;
  max_slots: number;
};

export type RiderScheduleRow = {
  id: string;
  rider_id: string;
  week_id: string;
  work_date: string;
  slot_id: string | null;
  is_selected: boolean | null;
};

export type XlsSlotDef = {
  name: string;
  startTime: string;
  endTime: string;
  sortOrder: number;
};

export type XlsEntry = {
  riderId: string;
  riderName: string;
  date: string;
  selections: number[];
};

export type XlsData = {
  weekStart: string;
  weekEnd: string;
  group: { id: string; name: string };
  slots: XlsSlotDef[];
  entries: XlsEntry[];
};
