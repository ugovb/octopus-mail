// Polish dictionary, split by area so translations can be edited side by side.
import type { Dictionary } from '../i18n'
import calendar from './pl/calendar'
import cli from './pl/cli'
import components from './pl/components'
import core from './pl/core'
import platform from './pl/platform'
import settings from './pl/settings'
import views from './pl/views'

const parts = [components, settings, calendar, views, platform, core, cli]
const pl: Dictionary = {
  strings: Object.assign({}, ...parts.map((p) => p.strings)),
  plurals: Object.assign({}, ...parts.map((p) => p.plurals)),
}
export default pl
