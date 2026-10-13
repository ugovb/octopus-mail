// Calendar module: sources (Google / CalDAV / ICS / local), sync, queries with recurrence
// expansion, write-through edits with iTIP e-mail invitations, invitations in mail,
// availability and reminders.
export {
  addCalendarSource, type CalendarSourceInfo, type CalendarSourceInput, ensureGoogleCalendarSources, listCalendarSources,
  localCalendarName, removeCalendarSource,
} from './sources'
export { syncCalendars } from './calsync'
export { type CalendarOccurrence, getEvent, listCalendars, listEvents, updateCalendar } from './store'
export { createEvent, deleteEvent, rsvpEvent, type RsvpResponse, updateEvent } from './mutations'
export { applyInviteCancel, type InviteInfo, inviteInfoFromIcs, inviteSource, parseInvite, rsvpInvite } from './invites'
export { type AvailabilityOptions, findAvailability } from './availability'
export { calendarTick, fireDueAlarms, type UpcomingAlarm, upcomingAlarms } from './alarms'
export { type Attendee, expandIcs, extractConferenceUrl, type InviteData, type Occurrence, parseInviteIcs } from './ical'
export { itipTransport } from './itip'
