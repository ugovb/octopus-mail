import tls from 'node:tls'

let done = false

/**
 * Trust the Windows certificate store in addition to Node's bundled Mozilla list.
 * Antivirus mail shields (e.g. Kaspersky) re-sign IMAP/SMTP connections with a root certificate
 * installed in Windows; native mail apps accept it, Node alone would reject every connection.
 */
export function trustSystemCertificates(): void {
  if (done) return
  done = true
  try {
    const system = tls.getCACertificates('system')
    if (!system.length) return
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('bundled'), ...system])])
  } catch {
    /* older runtime without these APIs: keep Node's defaults */
  }
}
