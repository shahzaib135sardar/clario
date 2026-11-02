import { useEffect, useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { INSTALL_DISMISSED_KEY, chooseInstallHint, isIosSafari } from '../lib/pwa'

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

/** Android/desktop: the browser's own install prompt. iOS Safari: a one-line how-to. Dismissible. */
export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [standalone, setStandalone] = useState(isStandalone)

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault() // keep the event so the install button can trigger it later
      setInstallEvent(event as InstallEvent)
    }
    const onInstalled = () => {
      setInstallEvent(null)
      setStandalone(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const hint = chooseInstallHint({
    standalone,
    dismissed,
    hasNativePrompt: installEvent !== null,
    ios: isIosSafari(navigator.userAgent, navigator.maxTouchPoints),
  })
  if (hint === 'none') return null

  function dismiss() {
    setDismissed(true)
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
    } catch {
      /* storage blocked: it just reappears next visit */
    }
  }

  async function install() {
    if (!installEvent) return
    await installEvent.prompt()
    await installEvent.userChoice.catch(() => undefined)
    setInstallEvent(null)
  }

  return <div className="install-prompt" role="region" aria-label="Install Clario">
    <span className="install-prompt-icon" aria-hidden="true">{hint === 'ios' ? <Share size={16} /> : <Download size={16} />}</span>
    <span className="install-prompt-copy">
      {hint === 'ios' ? <>Install Clario: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</> : <>Install Clario for one-tap access, like an app.</>}
    </span>
    {hint === 'native' && <button className="button button-dark button-small" onClick={() => void install()}>Install</button>}
    <button className="icon-button" aria-label="Dismiss install hint" onClick={dismiss}><X size={16} /></button>
  </div>
}
