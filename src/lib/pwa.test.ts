import { describe, expect, it } from 'vitest'
import { chooseInstallHint, isIosSafari } from './pwa'

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36'
const IPADOS_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

describe('isIosSafari', () => {
  it('detects iPhone Safari', () => expect(isIosSafari(IPHONE_SAFARI)).toBe(true))
  it('rejects Chrome on iOS', () => expect(isIosSafari(IPHONE_CHROME)).toBe(false))
  it('rejects Android', () => expect(isIosSafari(ANDROID_CHROME)).toBe(false))
  it('detects iPadOS Safari, which reports as a Mac with touch', () => {
    expect(isIosSafari(IPADOS_SAFARI, 5)).toBe(true)
    expect(isIosSafari(IPADOS_SAFARI, 0)).toBe(false)
  })
})

describe('chooseInstallHint', () => {
  const base = { standalone: false, dismissed: false, hasNativePrompt: false, ios: false }
  it('shows nothing once installed or dismissed', () => {
    expect(chooseInstallHint({ ...base, standalone: true, hasNativePrompt: true })).toBe('none')
    expect(chooseInstallHint({ ...base, dismissed: true, ios: true })).toBe('none')
  })
  it('prefers the native prompt, then the iOS hint', () => {
    expect(chooseInstallHint({ ...base, hasNativePrompt: true, ios: true })).toBe('native')
    expect(chooseInstallHint({ ...base, ios: true })).toBe('ios')
    expect(chooseInstallHint(base)).toBe('none')
  })
})
