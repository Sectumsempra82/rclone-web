export type TransferRequest = {
    requestId: string
    source: { fs: string; path: string; name: string; isDir: boolean; size?: number }
    dstFs: string
    dstCurrentPath: string
    mode: 'copy' | 'move'
}

export type QueueEntry = {
    id: string
    groupId: string
    seq: number
    srcFs: string
    srcRemote: string
    dstFs: string
    dstRemote: string
    mode: 'copy' | 'move'
    kind: 'file' | 'directory'
    size: number
    status: 'pending' | 'dispatching' | 'running' | 'failed'
    jobId: number | null
    executeId: string | null
    error: string
}

export type ByteProgress = {
    transferredBytes: number
    totalBytes: number
    totalKnown: boolean
    percent: number | null
}

export type QueueGroup = {
    progress: ByteProgress
    id: string
    seq: number
    label: string
    paused: boolean
    total: number
    active: number
    failed: number
}

export type QueueSnapshot = {
    progress: ByteProgress
    groups: QueueGroup[]
    paused: boolean
    entries: QueueEntry[]
    total: number
    active: number
    failed: number
    offset: number
    limit: number
    executeId: string
    error: string
}
