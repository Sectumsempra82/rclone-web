import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
    ByteProgress,
    QueueEntry,
    QueueGroup,
    QueueSnapshot,
    TransferRequest,
} from '../src/rclone/queue-types.js'

export type RC = (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>
const join = (...parts: string[]) => parts.filter(Boolean).join('/')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function remote(value: unknown, label: string): string {
    if (
        typeof value !== 'string' ||
        value.length > 16384 ||
        value.includes('\0') ||
        value.startsWith('/') ||
        value.split('/').some((part) => part === '..' || part === '.')
    ) {
        throw new Error(`Invalid ${label}`)
    }
    return value.replace(/\/+$/, '')
}
function fs(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0'))
        throw new Error('Invalid filesystem')
    return value
}
export function validateTransfer(input: TransferRequest): TransferRequest {
    if (
        !input?.source ||
        !['copy', 'move'].includes(input.mode) ||
        typeof input.source.isDir !== 'boolean' ||
        typeof input.requestId !== 'string' ||
        !/^[\w-]{1,80}$/.test(input.requestId)
    )
        throw new Error('Invalid transfer request')
    const source = {
        fs: fs(input.source.fs),
        path: remote(input.source.path, 'source'),
        name: remote(input.source.name, 'name'),
        isDir: input.source.isDir,
        size:
            typeof input.source.size === 'number' &&
            Number.isFinite(input.source.size) &&
            input.source.size >= 0
                ? input.source.size
                : undefined,
    }
    if (!source.name || source.name.includes('/')) throw new Error('Invalid source name')
    const dstFs = fs(input.dstFs)
    const dstCurrentPath = remote(input.dstCurrentPath, 'destination')
    const dstPath = join(dstCurrentPath, source.name)
    if (
        source.fs === dstFs &&
        (source.path === dstPath || (source.isDir && dstPath.startsWith(`${source.path}/`)))
    )
        throw new Error('Destination must be outside the source')
    return { requestId: input.requestId, source, dstFs, dstCurrentPath, mode: input.mode }
}

export async function checkTransferRoots(rc: RC, input: TransferRequest): Promise<TransferRequest> {
    const request = validateTransfer(input)
    const [source, destination] = await Promise.all([
        rc('/operations/fsinfo', { fs: request.source.fs }),
        rc('/operations/fsinfo', { fs: request.dstFs }),
    ])
    if (
        typeof source.Root !== 'string' ||
        typeof destination.Root !== 'string' ||
        typeof source.Name !== 'string' ||
        typeof destination.Name !== 'string'
    )
        throw new Error('Cannot verify source and destination roots')
    if (source.Name === destination.Name) {
        const sourceFeatures = source.Features as { CaseInsensitive?: boolean } | undefined
        const destinationFeatures = destination.Features as
            | { CaseInsensitive?: boolean }
            | undefined
        const normalize = (path: string) => {
            const result = posix.normalize(path).replace(/\/+$/, '')
            return sourceFeatures?.CaseInsensitive || destinationFeatures?.CaseInsensitive
                ? result.toLowerCase()
                : result
        }
        const from = normalize(join(source.Root, request.source.path))
        const to = normalize(join(destination.Root, request.dstCurrentPath, request.source.name))
        if (from === to || (request.source.isDir && to.startsWith(`${from}/`)))
            throw new Error('Destination resolves inside the source; choose another location')
    }
    if (!request.source.isDir) {
        request.source.size = undefined
        try {
            const stat = await rc('/operations/stat', {
                fs: request.source.fs,
                remote: request.source.path,
            })
            const item = stat.item as { Size?: number } | null
            request.source.size =
                typeof item?.Size === 'number' && Number.isFinite(item.Size) && item.Size >= 0
                    ? item.Size
                    : undefined
        } catch {
            // The worker can resolve size later without rejecting the queued work.
        }
    }
    return request
}

export function byteProgress(
    transferredBytes: number,
    totalBytes: number,
    totalKnown: boolean,
    finished: boolean
): ByteProgress {
    const percent = !totalKnown
        ? null
        : totalBytes > 0
          ? Math.min(finished ? 100 : 99.9, (transferredBytes / totalBytes) * 100)
          : finished
            ? 100
            : 0
    return { transferredBytes, totalBytes, totalKnown, percent }
}

export class Queue {
    readonly db: DatabaseSync
    private ticking = false
    private closed = false
    private liveBytes = new Map<string, number>()
    error = ''
    constructor(
        path: string,
        private rc: RC,
        private concurrency = 4
    ) {
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
            throw new Error('Queue concurrency must be 1–64')
        this.db = new DatabaseSync(path)
        this.db.exec(`
            PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL);
            INSERT OR IGNORE INTO settings VALUES (1,0);
            CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS queue_groups (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, label TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                srcFs TEXT NOT NULL, srcRemote TEXT NOT NULL, dstFs TEXT NOT NULL, dstRemote TEXT NOT NULL,
                mode TEXT NOT NULL, kind TEXT NOT NULL, size REAL NOT NULL DEFAULT 0,
                groupId TEXT NOT NULL DEFAULT 'legacy', status TEXT NOT NULL DEFAULT 'pending', jobId INTEGER, executeId TEXT, error TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS queue_status ON entries(status,seq);
            UPDATE settings SET paused=1 WHERE EXISTS(SELECT 1 FROM entries WHERE status='dispatching' AND kind='file');
            UPDATE entries SET status='failed', error='Submission interrupted; check destination and rclone jobs before resubmitting.' WHERE status='dispatching' AND kind='file';
            UPDATE entries SET status='pending' WHERE status='dispatching' AND kind='directory';
        `)
        this.transaction(() => {
            if (
                !this.db
                    .prepare('PRAGMA table_info(entries)')
                    .all()
                    .some((column) => column.name === 'groupId')
            ) {
                this.db.exec(
                    "ALTER TABLE entries ADD COLUMN groupId TEXT NOT NULL DEFAULT 'legacy'"
                )
            }
            const groupColumns = this.db.prepare('PRAGMA table_info(queue_groups)').all()
            if (!groupColumns.some((column) => column.name === 'completedBytes'))
                this.db.exec("UPDATE entries SET size=-1 WHERE kind='file' AND size=0")
            for (const column of [
                'completedBytes',
                'completedFiles',
                'unknownCompleted',
                'archived',
            ]) {
                if (!groupColumns.some((item) => item.name === column))
                    this.db.exec(
                        `ALTER TABLE queue_groups ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
                    )
            }
            this.db.exec(`
                INSERT OR IGNORE INTO queue_groups (id,label) SELECT 'legacy','Existing queue' WHERE EXISTS(SELECT 1 FROM entries WHERE groupId='legacy');
                CREATE INDEX IF NOT EXISTS queue_group_status ON entries(groupId,status,seq);
            `)
        })
    }
    private transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            this.db.exec('COMMIT')
            return result
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }
    private insert(
        entry: Pick<
            QueueEntry,
            'groupId' | 'srcFs' | 'srcRemote' | 'dstFs' | 'dstRemote' | 'mode' | 'kind' | 'size'
        >
    ) {
        this.db
            .prepare(
                'INSERT INTO entries (id,groupId,srcFs,srcRemote,dstFs,dstRemote,mode,kind,size) VALUES (?,?,?,?,?,?,?,?,?)'
            )
            .run(
                randomUUID(),
                entry.groupId,
                entry.srcFs,
                entry.srcRemote,
                entry.dstFs,
                entry.dstRemote,
                entry.mode,
                entry.kind,
                entry.size
            )
    }
    enqueue(input: TransferRequest) {
        const request = validateTransfer(input)
        const payload = JSON.stringify(request)
        return this.transaction(() => {
            const previous = this.db
                .prepare('SELECT payload FROM submissions WHERE id=?')
                .get(request.requestId)
            if (previous) {
                if (previous.payload !== payload)
                    throw new Error('Request ID already used for another transfer')
                return
            }
            if (!this.db.prepare('SELECT 1 FROM entries LIMIT 1').get())
                this.db.exec('UPDATE queue_groups SET archived=1')
            this.db.prepare('INSERT INTO submissions VALUES (?,?)').run(request.requestId, payload)
            this.db
                .prepare('INSERT INTO queue_groups (id,label) VALUES (?,?)')
                .run(request.requestId, request.source.name)
            this.insert({
                groupId: request.requestId,
                srcFs: request.source.fs,
                srcRemote: request.source.path,
                dstFs: request.dstFs,
                dstRemote: join(request.dstCurrentPath, request.source.name),
                mode: request.mode,
                kind: request.source.isDir ? 'directory' : 'file',
                size: request.source.isDir ? 0 : (request.source.size ?? -1),
            })
        })
    }
    get paused(): boolean {
        return this.db.prepare('SELECT paused FROM settings WHERE id=1').get()?.paused === 1
    }
    setPaused(paused: boolean) {
        this.db.prepare('UPDATE settings SET paused=? WHERE id=1').run(Number(paused))
    }
    setGroupPaused(id: string, paused: boolean): boolean {
        return (
            this.db.prepare('UPDATE queue_groups SET paused=? WHERE id=?').run(Number(paused), id)
                .changes !== 0
        )
    }
    remove(ids: string[]) {
        return this.transaction(() => {
            let removed = 0
            for (const id of new Set(ids)) {
                removed += Number(
                    this.db
                        .prepare(
                            "DELETE FROM entries WHERE id=? AND status IN ('pending','failed')"
                        )
                        .run(id).changes
                )
            }
            return removed
        })
    }
    snapshot(executeId: string, offset = 0, groupId?: string): QueueSnapshot {
        const rows = this.db
            .prepare(`
            SELECT g.id,g.seq,g.label,g.paused,g.completedBytes,g.completedFiles,
                COUNT(e.id) AS remaining,
                COALESCE(SUM(e.status != 'running'),0) AS total,
                COALESCE(SUM(e.status IN ('running','dispatching')),0) AS active,
                COALESCE(SUM(e.status = 'failed'),0) AS failed,
                COALESCE(SUM(CASE WHEN e.kind='file' THEN MAX(0,e.size) ELSE 0 END),0) AS remainingBytes,
                COALESCE(SUM(e.kind='directory' OR e.size<0),0) + g.unknownCompleted AS unknown
            FROM queue_groups g LEFT JOIN entries e ON e.groupId=g.id
            WHERE g.archived=0 GROUP BY g.id
            HAVING COUNT(e.id)>0 OR g.completedFiles>0 ORDER BY g.seq
        `)
            .all()
        const liveByGroup = new Map<string, number>()
        for (const entry of this.db
            .prepare("SELECT id,groupId,size,executeId FROM entries WHERE status='running'")
            .all()) {
            if (entry.executeId !== executeId) continue
            const bytes = Math.min(
                Math.max(0, Number(entry.size)),
                this.liveBytes.get(String(entry.id)) ?? 0
            )
            liveByGroup.set(
                String(entry.groupId),
                (liveByGroup.get(String(entry.groupId)) ?? 0) + bytes
            )
        }
        const groups: QueueGroup[] = rows.map((row) => ({
            id: String(row.id),
            seq: Number(row.seq),
            label: String(row.label),
            paused: row.paused === 1,
            total: Number(row.total),
            active: Number(row.active),
            failed: Number(row.failed),
            progress: byteProgress(
                Number(row.completedBytes) + (liveByGroup.get(String(row.id)) ?? 0),
                Number(row.completedBytes) + Number(row.remainingBytes),
                Number(row.unknown) === 0,
                Number(row.remaining) === 0
            ),
        }))
        const progress = byteProgress(
            groups.reduce((sum, group) => sum + group.progress.transferredBytes, 0),
            groups.reduce((sum, group) => sum + group.progress.totalBytes, 0),
            groups.every((group) => group.progress.totalKnown),
            groups.length > 0 && rows.every((row) => Number(row.remaining) === 0)
        )
        const selectedGroup = groupId ? groups.find((group) => group.id === groupId) : undefined
        const total = groupId
            ? (selectedGroup?.total ?? 0)
            : Number(
                  this.db
                      .prepare("SELECT count(*) AS n FROM entries WHERE status != 'running'")
                      .get()?.n ?? 0
              )
        offset = Math.min(Math.max(0, offset), Math.max(0, Math.floor((total - 1) / 100) * 100))
        return {
            groups,
            progress,
            paused: this.paused,
            executeId,
            error: this.error,
            offset,
            limit: 100,
            total,
            active: Number(
                this.db
                    .prepare(
                        "SELECT count(*) AS n FROM entries WHERE status IN ('running','dispatching')"
                    )
                    .get()?.n ?? 0
            ),
            failed: Number(
                this.db.prepare("SELECT count(*) AS n FROM entries WHERE status='failed'").get()
                    ?.n ?? 0
            ),
            entries: groupId
                ? (this.db
                      .prepare(
                          "SELECT * FROM entries WHERE groupId=? AND status != 'running' ORDER BY seq LIMIT 100 OFFSET ?"
                      )
                      .all(groupId, offset) as unknown as QueueEntry[])
                : (this.db
                      .prepare(
                          "SELECT * FROM entries WHERE status != 'running' ORDER BY seq LIMIT 100 OFFSET ?"
                      )
                      .all(offset) as unknown as QueueEntry[]),
        }
    }
    private fail(id: string, error: string, pause = false) {
        this.liveBytes.delete(id)
        this.db.prepare("UPDATE entries SET status='failed',error=? WHERE id=?").run(error, id)
        if (pause) this.setPaused(true)
    }
    private async expand(entry: QueueEntry) {
        const result = await this.rc('/operations/list', {
            fs: entry.srcFs,
            remote: entry.srcRemote,
            opt: { recurse: false },
        })
        if (!Array.isArray(result.list)) throw new Error('Invalid directory listing')
        const children = result.list.map((item: { Name: string; IsDir: boolean; Size: number }) => {
            const name = remote(item.Name, 'listed name')
            if (!name || name.includes('/') || typeof item.IsDir !== 'boolean')
                throw new Error('Invalid directory entry')
            return {
                ...entry,
                srcRemote: join(entry.srcRemote, name),
                dstRemote: join(entry.dstRemote, name),
                kind: item.IsDir ? ('directory' as const) : ('file' as const),
                size: item.IsDir ? 0 : Number.isFinite(item.Size) ? Math.max(-1, item.Size) : -1,
            }
        })
        await this.rc('/operations/mkdir', { fs: entry.dstFs, remote: entry.dstRemote })
        this.transaction(() => {
            for (const child of children) this.insert(child)
            this.db.prepare('DELETE FROM entries WHERE id=?').run(entry.id)
        })
    }
    private async start(entry: QueueEntry, executeId: string) {
        try {
            if (entry.kind === 'directory') {
                await this.expand(entry)
                return
            }
            try {
                const stat = await this.rc('/operations/stat', {
                    fs: entry.srcFs,
                    remote: entry.srcRemote,
                })
                const item = stat.item as { Size?: number } | null
                if (
                    typeof item?.Size === 'number' &&
                    Number.isFinite(item.Size) &&
                    item.Size >= 0
                ) {
                    this.db.prepare('UPDATE entries SET size=? WHERE id=?').run(item.Size, entry.id)
                }
            } catch {
                // Size discovery must not prevent an otherwise valid transfer.
            }
            const result = await this.rc(`/operations/${entry.mode}file`, {
                srcFs: entry.srcFs,
                srcRemote: entry.srcRemote,
                dstFs: entry.dstFs,
                dstRemote: entry.dstRemote,
                _async: true,
            })
            if (!Number.isSafeInteger(result.jobid) || result.executeId !== executeId)
                throw new Error('Uncertain job submission')
            this.db
                .prepare("UPDATE entries SET status='running',jobId=?,executeId=? WHERE id=?")
                .run(result.jobid as number, executeId, entry.id)
        } catch (error) {
            this.fail(
                entry.id,
                `${message(error)}${entry.kind === 'file' ? ' Check rclone jobs and destination before resubmitting.' : ''}`,
                entry.kind === 'file'
            )
        }
    }
    async tick() {
        if (this.ticking || this.closed) return
        const hasRunning = this.db
            .prepare("SELECT 1 FROM entries WHERE status='running' LIMIT 1")
            .get()
        const hasPending = this.db
            .prepare(
                "SELECT 1 FROM entries e JOIN queue_groups g ON g.id=e.groupId WHERE e.status='pending' AND g.paused=0 LIMIT 1"
            )
            .get()
        if (!hasRunning && (this.paused || !hasPending)) return
        this.ticking = true
        try {
            const { executeId } = await this.rc('/job/list')
            if (typeof executeId !== 'string' || !executeId)
                throw new Error('Invalid rclone instance ID')
            const running = this.db
                .prepare("SELECT * FROM entries WHERE status='running'")
                .all() as unknown as QueueEntry[]
            const polls = await Promise.allSettled(
                running.map(async (entry) => {
                    if (entry.executeId !== executeId) {
                        this.fail(
                            entry.id,
                            'Rclone restarted. Check destination before resubmitting.',
                            true
                        )
                        return
                    }
                    const status = await this.rc('/job/status', { jobid: entry.jobId })
                    if (status.executeId && status.executeId !== entry.executeId) {
                        this.fail(
                            entry.id,
                            'Rclone changed during status check. Review before resubmitting.',
                            true
                        )
                        return
                    }
                    if (status.finished === true) {
                        if (status.success === true) {
                            this.transaction(() => {
                                this.db
                                    .prepare(
                                        'UPDATE queue_groups SET completedBytes=completedBytes+?, completedFiles=completedFiles+1, unknownCompleted=unknownCompleted+? WHERE id=?'
                                    )
                                    .run(
                                        Math.max(0, entry.size),
                                        Number(entry.size < 0),
                                        entry.groupId
                                    )
                                this.db.prepare('DELETE FROM entries WHERE id=?').run(entry.id)
                            })
                            this.liveBytes.delete(entry.id)
                        } else
                            this.fail(
                                entry.id,
                                String(status.error || 'Transfer failed'),
                                status.missing === true
                            )
                    } else {
                        const stats = await this.rc('/core/stats', { group: `job/${entry.jobId}` })
                        const transfers = Array.isArray(stats.transferring)
                            ? stats.transferring
                            : []
                        this.liveBytes.set(
                            entry.id,
                            transfers.reduce(
                                (sum: number, item: { bytes?: number }) =>
                                    sum +
                                    (typeof item.bytes === 'number' && Number.isFinite(item.bytes)
                                        ? Math.max(0, item.bytes)
                                        : 0),
                                0
                            )
                        )
                    }
                })
            )
            const failedPoll = polls.find((result) => result.status === 'rejected')
            if (failedPoll?.status === 'rejected') throw failedPoll.reason
            this.error = ''
            const starts: Promise<void>[] = []
            while (
                !this.closed &&
                !this.paused &&
                starts.length +
                    Number(
                        this.db
                            .prepare("SELECT count(*) AS n FROM entries WHERE status='running'")
                            .get()?.n ?? 0
                    ) <
                    this.concurrency
            ) {
                const entry = this.db
                    .prepare(
                        "SELECT e.* FROM entries e JOIN queue_groups g ON g.id=e.groupId WHERE e.status='pending' AND g.paused=0 ORDER BY e.seq LIMIT 1"
                    )
                    .get() as unknown as QueueEntry | undefined
                if (!entry) break
                const claim = this.db
                    .prepare(
                        "UPDATE entries SET status='dispatching' WHERE id=? AND status='pending'"
                    )
                    .run(entry.id)
                if (claim.changes === 0) break
                starts.push(this.start(entry, executeId))
            }
            await Promise.all(starts)
        } catch (error) {
            this.error = message(error)
        } finally {
            this.ticking = false
        }
    }
    async close() {
        this.closed = true
        while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10))
        this.db.close()
    }
}
