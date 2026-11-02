import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

// Server-side request forgery guard for any URL the server is asked to fetch
// that an operator or user could influence (today: EXTERNAL_CHATBOT_URL). Blocks
// non-http(s), embedded credentials, localhost, and private/loopback/link-local/
// metadata addresses, including odd encodings (decimal, hex, octal, IPv4-mapped IPv6).

export class UnsafeUrlError extends Error {}

function ipv4ToNumber(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

const PRIVATE_V4: [number, number][] = [
  [ipv4ToNumber([0, 0, 0, 0]), 8],
  [ipv4ToNumber([10, 0, 0, 0]), 8],
  [ipv4ToNumber([100, 64, 0, 0]), 10],
  [ipv4ToNumber([127, 0, 0, 0]), 8],
  [ipv4ToNumber([169, 254, 0, 0]), 16], // link-local, cloud metadata (169.254.169.254)
  [ipv4ToNumber([172, 16, 0, 0]), 12],
  [ipv4ToNumber([192, 0, 0, 0]), 24],
  [ipv4ToNumber([192, 168, 0, 0]), 16],
  [ipv4ToNumber([198, 18, 0, 0]), 15],
  [ipv4ToNumber([224, 0, 0, 0]), 4], // multicast + reserved
  [ipv4ToNumber([240, 0, 0, 0]), 4],
]

function inRange(address: number, [base, bits]: [number, number]): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (address & mask) === (base & mask)
}

export function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const value = ipv4ToNumber(parts)
  return PRIVATE_V4.some((range) => inRange(value, range))
}

export function isPrivateIpv6(host: string): boolean {
  const address = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (address === '::' || address === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return isPrivateIpv4(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const first = parseInt(address.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // multicast
  return false
}

/** WHATWG URL already normalises decimal/hex/octal IPv4 hosts to dotted form; this checks the result. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') return true
  const bare = host.replace(/^\[|\]$/g, '')
  const kind = isIP(bare)
  if (kind === 4) return isPrivateIpv4(bare)
  if (kind === 6) return isPrivateIpv6(bare)
  return false
}

export type Resolver = (hostname: string) => Promise<string[]>
const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address)

/**
 * Throws UnsafeUrlError unless the URL is safe to fetch. With `resolve`, a hostname
 * that resolves to a private address is also rejected (DNS-rebinding style names).
 */
export async function assertSafeOutboundUrl(
  raw: string,
  options: { allowHttp?: boolean; allowPrivate?: boolean; resolve?: boolean; resolver?: Resolver } = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('The URL is not valid.')
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeUrlError(options.allowHttp ? 'Only http and https URLs are allowed.' : 'Only https URLs are allowed.')
  }
  if (url.username || url.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed.')
  if (!options.allowPrivate && isBlockedHost(url.hostname)) throw new UnsafeUrlError('That address is not allowed.')

  if (options.resolve && isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0) {
    let addresses: string[]
    try {
      addresses = await (options.resolver ?? defaultResolver)(url.hostname)
    } catch {
      throw new UnsafeUrlError('The host could not be resolved.')
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedHost(address))) throw new UnsafeUrlError('That address is not allowed.')
  }
  return url
}
