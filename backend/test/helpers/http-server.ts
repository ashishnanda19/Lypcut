import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export interface TestServer {
  url: string
  requests: Recorded[]
  close(): Promise<void>
}

type Handler = (req: Recorded, res: http.ServerResponse) => void | Promise<void>

/** A throwaway HTTP server that records every request, standing in for a hosted API. */
export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Recorded[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(recorded)
      Promise.resolve(handler(recorded, res)).catch((e) => {
        res.statusCode = 500
        res.end(String(e))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
