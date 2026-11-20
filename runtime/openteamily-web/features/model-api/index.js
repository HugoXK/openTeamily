// B4 model-api feature: the account model settings drive this user's DS-Bot
// through the #379 loopback model proxy (in-process override, no key in
// DS-Bot settings, env or responses). Endpoints: model-api/get, model-api/save,
// model-api/v1 (legacy /v1/model-api compat). Workspace-scope model settings
// stay on the platform with teams (phase C).
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { loadSealKey } from '../../lib/b4/seal.js'
import { createModelApi, OVERRIDE } from './model-api.js'

export default function modelApi(host) {
  const dir = host.featureDir()
  const api = createModelApi({ dir, sealKey: loadSealKey({ fallbackFile: join(dir, 'seal.key') }) })
  globalThis[OVERRIDE] = () => api.resolveForProxy()
  return {
    pages: ['settings'],
    endpoints: {
      get: async () => api.get(),
      save: async payload => api.save(payload),
      v1: compatHandler(api.legacy),
    },
  }
}
