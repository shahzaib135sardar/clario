import { createGateway } from './app'
import { loadConfig } from './config'
import { log } from './log'

// Entry point of the self-host server (Docker / Kubernetes). On Vercel this file is not used.
const config = loadConfig()
const gateway = createGateway(config)
const server = gateway.listen()
log('info', 'server listening', { port: config.port, staticDir: config.staticDir, maxInFlight: config.maxInFlight })

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log('info', 'shutdown requested', { signal, drainMs: config.shutdownDrainMs })
  const outcome = await gateway.shutdown(server)
  log(outcome.drained ? 'info' : 'warn', 'shutdown complete', outcome)
  process.exit(outcome.drained ? 0 : 1)
}

process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) }))
process.on('uncaughtException', (error) => {
  log('error', 'uncaught exception', { reason: error.message })
  void stop('uncaughtException')
})
