// Small, pure helpers for the "install this app" hint.

/** iPhone/iPad Safari (not Chrome/Firefox/Edge on iOS, which cannot add to the home screen here). */
export function isIosSafari(userAgent: string, maxTouchPoints = 0): boolean {
  const isIosDevice = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  if (!isIosDevice) return false
  return /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(userAgent)
}

export const INSTALL_DISMISSED_KEY = 'clario:install-dismissed'

export type InstallHint = 'native' | 'ios' | 'none'

/** Decides which install hint, if any, to show. */
export function chooseInstallHint(input: {
  standalone: boolean
  dismissed: boolean
  hasNativePrompt: boolean
  ios: boolean
}): InstallHint {
  if (input.standalone || input.dismissed) return 'none'
  if (input.hasNativePrompt) return 'native'
  return input.ios ? 'ios' : 'none'
}
