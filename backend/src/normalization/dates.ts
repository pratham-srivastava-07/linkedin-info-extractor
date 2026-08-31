import { DashDate, DashDateRange } from "../interfaces/linkedin"

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

export const formatDate = (date?: DashDate): string | null => {
  if (!date?.year) return null
  const month = date.month && date.month >= 1 && date.month <= 12 ? MONTHS[date.month - 1] : null
  return month ? `${month} ${date.year}` : String(date.year)
}

/**
 * Renders a dash `dateRange` the way api.md shows it: "Jan 2022 - Present" for
 * an ongoing role, "2016 - 2020" where upstream only gave us years. An entry
 * with no dates at all is `null` rather than an empty or half-formed string.
 *
 * The legacy surface called this `timePeriod: { startDate, endDate }`; dash
 * calls it `dateRange: { start, end }`. Only the dash spelling exists now.
 */
export const formatDateRange = (range?: DashDateRange): string | null => {
  const start = formatDate(range?.start)
  const end = formatDate(range?.end)
  if (start && end) return `${start} - ${end}`
  if (start) return `${start} - Present`
  // Some education entries carry only a graduation year.
  if (end) return end
  return null
}
