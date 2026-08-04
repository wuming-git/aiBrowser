import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

const FILE = 'device-id.txt'

export function getDeviceId(): string {
  const file = path.join(app.getPath('userData'), FILE)
  try {
    if (fs.existsSync(file)) {
      const id = fs.readFileSync(file, 'utf-8').trim()
      if (id) return id
    }
  } catch (_) {}
  const id = `desktop-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, id, 'utf-8')
  } catch (e) {
    console.warn('[Desktop] persist deviceId failed', e)
  }
  return id
}
