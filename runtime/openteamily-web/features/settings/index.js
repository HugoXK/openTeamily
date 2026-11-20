// B4 settings feature: preferences, notification prefs (#284), onboarding and
// the Personal Agent look, executed and stored in this user's own DS-Bot.
// Endpoints: settings/<op> and settings/v1 (legacy /v1 compat, see lib/b4/compat.js).
import { compatHandler } from '../../lib/b4/compat.js'
import { createSettingsFeature } from './settings.js'

export const LEGACY_PATHS = ['/v1/settings', '/v1/notification-prefs', '/v1/onboarding', '/v1/onboarding/recommendations', '/v1/onboarding/picks', '/v1/onboarding/look']

export default function settings(host) {
  const feature = createSettingsFeature({ dir: host.featureDir() })
  return {
    pages: ['settings', 'onboarding', 'look'],
    endpoints: { ...feature.endpoints, v1: compatHandler(feature.legacy) },
  }
}
