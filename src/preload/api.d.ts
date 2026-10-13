import type { OctoBridge } from './index'

declare global {
  interface Window {
    octo: OctoBridge
  }
}
export {}
