import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { TransferRequest } from '../src/rclone/queue-types.js'
import { checkTransferRoots, Queue, type RC } from './queue.js'

export function createRC(base: string, authorization: string): RC {
    const url = new URL(base)
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('Invalid RCLONE_URL')
    return async (path, body = {}) => {
        const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
            method: 'POST',
            headers: { Authorization: authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
            redirect: 'error',
        })
        const data = (await response.json()) as Record<string, unknown>
        if (path === '/job/status' && response.status === 404)
            return {
                finished: true,
                success: false,
                missing: true,
                error: 'Job status expired or unavailable. Check destination before resubmitting.',
            }
        if (!response.ok || (data.error && path !== '/job/status'))
            throw new Error(String(data.error || `Rclone returned ${response.status}`))
        return data
    }
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!request.headers['content-type']?.startsWith('application/json'))
        throw new Error('JSON required')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        size += chunk.length
        if (size > 65536) throw new Error('Request too large')
        chunks.push(chunk)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('JSON object required')
    return body as Record<string, unknown>
}

export function createGuiServer(queue: Queue, rc: RC, authorization: string, staticRoot: string) {
    const hash = (value: string) => createHash('sha256').update(value).digest()
    const expected = hash(authorization)
    return createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff')
        const send = (status: number, body: unknown) => {
            response.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            })
            response.end(JSON.stringify(body))
        }
        try {
            const url = new URL(request.url ?? '/', 'http://localhost')
            if (url.pathname.startsWith('/api/queue')) {
                if (!timingSafeEqual(expected, hash(request.headers.authorization ?? ''))) {
                    send(401, { error: 'Queue authentication required' })
                    return
                }
                if (
                    request.headers['sec-fetch-site'] === 'cross-site' ||
                    (request.headers.origin &&
                        new URL(request.headers.origin).host !== request.headers.host)
                ) {
                    send(403, { error: 'Cross-origin queue requests are not allowed' })
                    return
                }
                const { executeId } = await rc('/job/list')
                if (typeof executeId !== 'string' || !executeId)
                    throw new Error('Rclone instance unavailable')
                if (request.method === 'GET' && url.pathname === '/api/queue') {
                    const offset = Number(url.searchParams.get('offset') ?? 0)
                    if (!Number.isSafeInteger(offset) || offset < 0) {
                        send(400, { error: 'Invalid offset' })
                        return
                    }
                    send(
                        200,
                        queue.snapshot(
                            executeId,
                            offset,
                            url.searchParams.get('groupId') ?? undefined
                        )
                    )
                    return
                }
                if (request.method !== 'POST') {
                    send(405, { error: 'Method not allowed' })
                    return
                }
                if (request.headers['x-rclone-instance'] !== executeId) {
                    send(409, {
                        error: 'GUI and queue must use the same rclone backend. Refresh and retry.',
                    })
                    return
                }
                let body: Record<string, unknown>
                try {
                    body = await jsonBody(request)
                } catch (error) {
                    send(400, { error: error instanceof Error ? error.message : 'Invalid request' })
                    return
                }
                switch (url.pathname) {
                    case '/api/queue/enqueue':
                        try {
                            queue.enqueue(
                                await checkTransferRoots(rc, body as unknown as TransferRequest)
                            )
                        } catch (error) {
                            send(400, {
                                error: error instanceof Error ? error.message : 'Invalid transfer',
                            })
                            return
                        }
                        send(202, { accepted: true })
                        return
                    case '/api/queue/pause':
                        if (typeof body.paused !== 'boolean') {
                            send(400, { error: 'paused must be boolean' })
                            return
                        }
                        queue.setPaused(body.paused)
                        send(200, { paused: body.paused })
                        return
                    case '/api/queue/group-pause':
                        if (typeof body.groupId !== 'string' || typeof body.paused !== 'boolean') {
                            send(400, { error: 'groupId and paused are required' })
                            return
                        }
                        if (!queue.setGroupPaused(body.groupId, body.paused)) {
                            send(404, { error: 'Group not found' })
                            return
                        }
                        send(200, { paused: body.paused })
                        return
                    case '/api/queue/retry':
                        if (typeof body.id !== 'string' || !body.id || body.id.length > 80) {
                            send(400, { error: 'Supply an entry ID' })
                            return
                        }
                        if (!(await queue.retry(body.id, executeId))) {
                            send(409, { error: 'Entry is no longer failed. Refresh the queue.' })
                            return
                        }
                        send(200, { retried: true })
                        return
                    case '/api/queue/remove':
                        if (
                            !Array.isArray(body.ids) ||
                            body.ids.length > 100 ||
                            !body.ids.every((id) => typeof id === 'string' && id.length <= 80)
                        ) {
                            send(400, { error: 'Supply up to 100 entry IDs' })
                            return
                        }
                        send(200, { removed: queue.remove(body.ids as string[]) })
                        return
                    default:
                        send(404, { error: 'Unknown queue endpoint' })
                        return
                }
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                send(405, { error: 'Method not allowed' })
                return
            }
            const root = await realpath(staticRoot)
            const target = resolve(root, `.${decodeURIComponent(url.pathname)}`)
            if (target !== root && !target.startsWith(root + sep)) {
                send(403, { error: 'Forbidden' })
                return
            }
            let file = target
            try {
                if (!(await stat(file)).isFile()) file = resolve(root, 'index.html')
            } catch {
                file = resolve(root, 'index.html')
            }
            const actual = await realpath(file)
            if (!actual.startsWith(root + sep)) {
                send(403, { error: 'Forbidden' })
                return
            }
            const types: Record<string, string> = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.json': 'application/json',
                '.woff2': 'font/woff2',
            }
            response.writeHead(200, {
                'Content-Type': types[extname(file)] ?? 'application/octet-stream',
                'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
            })
            response.end(request.method === 'HEAD' ? undefined : await readFile(actual))
        } catch (error) {
            if (!response.headersSent)
                send(503, { error: error instanceof Error ? error.message : 'Service unavailable' })
            else response.end()
        }
    })
}

export async function start() {
    process.umask(0o077)
    const password = process.env.RCLONE_PASS_FILE
        ? (await readFile(process.env.RCLONE_PASS_FILE, 'utf8')).replace(/[\r\n]+$/, '')
        : process.env.RCLONE_PASS
    const user = process.env.RCLONE_USER
    if (!user || !password || !process.env.RCLONE_URL)
        throw new Error('Set RCLONE_URL, RCLONE_USER and RCLONE_PASS_FILE (or RCLONE_PASS)')
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
    const rc = createRC(process.env.RCLONE_URL, authorization)
    const directory = resolve(process.env.QUEUE_DATA_DIR || './queue-data')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const queue = new Queue(
        resolve(directory, 'queue.sqlite'),
        rc,
        Number(process.env.QUEUE_TRANSFERS || 4)
    )
    const server = createGuiServer(
        queue,
        rc,
        authorization,
        resolve(process.env.GUI_DIST || './dist')
    )
    const timer = setInterval(() => void queue.tick(), 500)
    void queue.tick()
    server.listen(Number(process.env.PORT || 5572), process.env.HOST || '127.0.0.1', () =>
        console.log('GUI queue service listening')
    )
    const shutdown = async () => {
        clearInterval(timer)
        server.close()
        await queue.close()
    }
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
}
