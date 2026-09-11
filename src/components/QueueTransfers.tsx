import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, PauseIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { PathLabel } from '@/components/PathLabel'
import { TransferByteProgress } from '@/components/TransferByteProgress'
import { TransfersTable } from '@/components/TransfersTable'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import type { JobRow } from '@/rclone/jobs'
import { fetchQueue, queueAction } from '@/rclone/queue'
import type { QueueGroup } from '@/rclone/queue-types'

const location = (fs: string, remote: string) =>
    `${fs}${fs.endsWith(':') || fs.endsWith('/') ? '' : '/'}${remote}`

function QueueGroupTable({
    group,
    globallyPaused,
}: {
    group: QueueGroup
    globallyPaused: boolean
}) {
    const t = useT()
    const queryClient = useQueryClient()
    const url = useStore((state) => state.url)
    const user = useStore((state) => state.user)
    const [expanded, setExpanded] = useState(true)
    const [offset, setOffset] = useState(0)
    const [selected, setSelected] = useState(new Set<string>())
    const query = useQuery({
        queryKey: ['guiQueue', url, user, group.id, offset],
        queryFn: () => fetchQueue(offset, group.id),
        refetchInterval: 1500,
        retry: false,
    })
    const data = query.data
    const currentGroup = data?.groups.find((item) => item.id === group.id) ?? group
    const label = t('queue.groupTitle', { number: group.seq, name: group.label })
    const mutation = useMutation({
        mutationFn: async ({
            action,
            body,
        }: {
            action: 'group-pause' | 'remove'
            body: object
        }) => {
            if (!data || query.isError) throw new Error(t('queue.unavailable'))
            return queueAction<{ removed?: number }>(action, body, data.executeId)
        },
        onSuccess: (result, variables) => {
            if (variables.action === 'remove') {
                setSelected(new Set())
                toast.success(t('queue.removed', { count: result.removed ?? 0 }))
            }
            queryClient.invalidateQueries({ queryKey: ['guiQueue'] })
        },
        onError: (error) => toast.error(error.message),
    })
    const busy = mutation.isPending || query.isError
    const entries = data?.entries ?? []
    const removable = entries.filter(
        (entry) => entry.status === 'pending' || entry.status === 'failed'
    )
    const selection = new Set(
        removable.filter((entry) => selected.has(entry.id)).map((entry) => entry.id)
    )
    const rows: JobRow[] = entries.map((entry) => ({
        rowKey: entry.id,
        id: entry.seq,
        status:
            entry.status === 'pending'
                ? 'queued'
                : entry.status === 'failed'
                  ? 'failed'
                  : 'running',
        startTime: '',
        source: location(entry.srcFs, entry.srcRemote) + (entry.kind === 'directory' ? '/' : ''),
        destination:
            location(entry.dstFs, entry.dstRemote) + (entry.kind === 'directory' ? '/' : ''),
        bytes: 0,
        totalBytes: entry.size,
        progress: 0,
        speedLabel: '—',
        etaLabel: '—',
        errorText: entry.error,
        canStop: false,
    }))
    const remove = (ids: string[]) => mutation.mutate({ action: 'remove', body: { ids } })
    const page = (next: number) => {
        setSelected(new Set())
        setOffset(next)
    }

    return (
        <section aria-label={label} className="space-y-2 rounded-xl border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                    variant="ghost"
                    className="min-w-0 justify-start"
                    aria-expanded={expanded}
                    aria-controls={`queue-group-${group.id}`}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    <PathLabel value={label} className="flex-1" />
                    <span className="text-xs text-muted-foreground">
                        {t('queue.count', {
                            count: currentGroup.total,
                            active: currentGroup.active,
                        })}
                    </span>
                </Button>
                <Button
                    size="sm"
                    variant={currentGroup.paused ? 'default' : 'destructive'}
                    disabled={
                        !data || busy || (currentGroup.total === 0 && currentGroup.active === 0)
                    }
                    onClick={() =>
                        mutation.mutate({
                            action: 'group-pause',
                            body: { groupId: group.id, paused: !currentGroup.paused },
                        })
                    }
                >
                    {currentGroup.paused ? <PlayIcon /> : <PauseIcon />}
                    {t(currentGroup.paused ? 'queue.resumeGroup' : 'queue.stopGroup')}
                </Button>
            </div>
            <TransferByteProgress
                label={t('queue.groupProgress')}
                progress={currentGroup.progress}
            />
            {globallyPaused ? (
                <p className="text-xs text-muted-foreground">{t('queue.globalPauseHint')}</p>
            ) : null}
            {query.isError ? (
                <p role="alert" className="text-sm text-destructive">
                    {query.error.message}
                </p>
            ) : null}
            {currentGroup.failed ? (
                <p className="text-sm text-destructive">{t('queue.failedHint')}</p>
            ) : null}
            <div id={`queue-group-${group.id}`} hidden={!expanded} className="space-y-2">
                {query.isPending ? (
                    <p className="text-sm text-muted-foreground">{t('queue.loading')}</p>
                ) : null}
                {data && !query.isError ? (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy || !selection.size}
                                onClick={() => remove([...selection])}
                            >
                                <Trash2Icon />
                                {t('queue.removeSelected', { count: selection.size })}
                            </Button>
                            <span className="text-xs text-muted-foreground">
                                {t('queue.removeHint')}
                            </span>
                        </div>
                        {rows.length ? (
                            <TransfersTable
                                jobs={rows}
                                onStop={() => {}}
                                isStopping={false}
                                queueControls={{
                                    selected: selection,
                                    busy,
                                    onSelect: (id, checked) =>
                                        setSelected((previous) => {
                                            const next = new Set(previous)
                                            if (checked) next.add(id)
                                            else next.delete(id)
                                            return next
                                        }),
                                    onSelectAll: (checked) =>
                                        setSelected(
                                            new Set(
                                                checked ? removable.map((entry) => entry.id) : []
                                            )
                                        ),
                                    onRemove: (id) => remove([id]),
                                }}
                            />
                        ) : (
                            <p className="rounded-xl border px-3 py-4 text-sm text-muted-foreground">
                                {t('queue.empty')}
                            </p>
                        )}
                        {data.total > data.limit ? (
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy || data.offset === 0}
                                    onClick={() => page(data.offset - data.limit)}
                                >
                                    {t('queue.previous')}
                                </Button>
                                <span className="text-xs">
                                    {data.offset + 1}–
                                    {Math.min(data.offset + data.limit, data.total)} / {data.total}
                                </span>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy || data.offset + data.limit >= data.total}
                                    onClick={() => page(data.offset + data.limit)}
                                >
                                    {t('queue.next')}
                                </Button>
                            </div>
                        ) : null}
                    </>
                ) : null}
            </div>
        </section>
    )
}

export function QueuePauseButton() {
    const t = useT()
    const queryClient = useQueryClient()
    const url = useStore((state) => state.url)
    const user = useStore((state) => state.user)
    const query = useQuery({
        queryKey: ['guiQueue', url, user],
        queryFn: () => fetchQueue(),
        refetchInterval: 1500,
        retry: false,
    })
    const data = query.data
    const pause = useMutation({
        mutationFn: async () => {
            if (!data || query.isError) throw new Error(t('queue.unavailable'))
            return queueAction('pause', { paused: !data.paused }, data.executeId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['guiQueue'] })
        },
        onError: (error) => toast.error(error.message),
    })
    return (
        <Button
            size="lg"
            title={t('queue.drainHint')}
            variant={data?.paused ? 'default' : 'destructive'}
            disabled={!data || query.isError || pause.isPending}
            onClick={() => pause.mutate()}
        >
            {data?.paused ? <PlayIcon /> : <PauseIcon />}
            {t(data?.paused ? 'queue.resume' : 'queue.stop')}
        </Button>
    )
}

export function QueueTransfers({ children }: { children: ReactNode }) {
    const t = useT()
    const url = useStore((state) => state.url)
    const user = useStore((state) => state.user)
    const [expanded, setExpanded] = useState(true)
    const query = useQuery({
        queryKey: ['guiQueue', url, user],
        queryFn: () => fetchQueue(),
        refetchInterval: 1500,
        retry: false,
    })
    const data = query.data
    return (
        <>
            {children}
            <section aria-label={t('queue.title')} className="space-y-4">
                <Button
                    variant="ghost"
                    className="w-full justify-start"
                    aria-expanded={expanded}
                    aria-controls="pending-queue"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    {t('queue.title')}
                    {data ? (
                        <span className="text-xs text-muted-foreground">
                            {t('queue.count', { count: data.total, active: data.active })}
                        </span>
                    ) : null}
                </Button>
                {query.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                        {query.error.message}
                    </p>
                ) : null}
                {data?.error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {data.error}
                    </p>
                ) : null}
                <div id="pending-queue" hidden={!expanded} className="space-y-6">
                    {query.isPending ? <p>{t('queue.loading')}</p> : null}
                    {data && !query.isError ? (
                        data.groups.length ? (
                            data.groups.map((group) => (
                                <QueueGroupTable
                                    key={group.id}
                                    group={group}
                                    globallyPaused={data.paused}
                                />
                            ))
                        ) : (
                            <p className="rounded-xl border px-3 py-4 text-sm text-muted-foreground">
                                {t('queue.empty')}
                            </p>
                        )
                    ) : null}
                </div>
            </section>
        </>
    )
}
