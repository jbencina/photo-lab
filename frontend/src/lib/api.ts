import type {
  AddTagResponse,
  AdminConfig,
  Facets,
  ImageDetail,
  ImagesResponse,
  IndexingState,
  LabelInfo,
  PropagatePreview,
  SearchResponse,
  Status,
  SubjectCount,
  SubjectScore,
  SuggestResponse,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

export type Params = Record<string, string | number | boolean | string[] | null | undefined>

function toQuery(params?: Params): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    if (Array.isArray(value)) {
      for (const v of value) if (v !== '') sp.append(key, v)
    } else if (value === true) {
      sp.append(key, '1')
    } else {
      sp.append(key, String(value))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { params?: Params; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}${toQuery(opts.params)}`, {
      method,
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err) {
    if (isAbort(err)) throw err
    throw new ApiError(0, 'Cannot reach the photo-lib server')
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string') message = data.detail
      else if (Array.isArray(data?.detail)) message = data.detail.map((d: { msg?: string }) => d.msg).join('; ')
      else if (typeof data?.error === 'string') message = data.error
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

const id = (value: string) => encodeURIComponent(value)

export const api = {
  status: (signal?: AbortSignal) => request<Status>('GET', '/status', { signal }),
  images: (params: Params, signal?: AbortSignal) => request<ImagesResponse>('GET', '/images', { params, signal }),
  image: (imageId: string, signal?: AbortSignal) => request<ImageDetail>('GET', `/images/${id(imageId)}`, { signal }),
  like: (imageId: string, liked: boolean) =>
    request<{ liked: boolean; liked_at: string | null }>('POST', `/images/${id(imageId)}/like`, { body: { liked } }),
  searchQuery: (params: Params, signal?: AbortSignal) =>
    request<SearchResponse>('GET', '/search/query', { params, signal }),
  searchSimilar: (imageId: string, params: Params, signal?: AbortSignal) =>
    request<SearchResponse>('GET', `/search/similar/${id(imageId)}`, { params, signal }),
  searchColor: (params: Params, signal?: AbortSignal) =>
    request<SearchResponse>('GET', '/search/color', { params, signal }),
  subjects: (signal?: AbortSignal) => request<{ items: SubjectCount[] }>('GET', '/subjects', { signal }),
  facets: (signal?: AbortSignal) => request<Facets>('GET', '/facets', { signal }),
  /** Manual tags on one photo. `addTag` creates the label when it is new (then `propagate` previews a library search). */
  addTag: (imageId: string, label: string) =>
    request<AddTagResponse>('POST', `/images/${id(imageId)}/tags`, { body: { label } }),
  removeTag: (imageId: string, label: string) =>
    request<{ label: string; subjects: SubjectScore[] }>('DELETE', `/images/${id(imageId)}/tags/${id(label)}`),
  labels: {
    list: (signal?: AbortSignal) => request<{ items: LabelInfo[] }>('GET', '/labels', { signal }),
    suggest: (q: string, imageId: string | null, signal?: AbortSignal) =>
      request<SuggestResponse>('GET', '/labels/suggest', { params: { q, image: imageId, limit: 8 }, signal }),
    propagatePreview: (label: string, signal?: AbortSignal) =>
      request<PropagatePreview>('GET', `/labels/${id(label)}/propagate/preview`, { signal }),
    propagate: (label: string) =>
      request<{ ok: boolean; started: boolean } & PropagatePreview>('POST', `/labels/${id(label)}/propagate`, {
        body: { confirm: true },
      }),
  },
  admin: {
    config: (signal?: AbortSignal) => request<AdminConfig>('GET', '/admin/config', { signal }),
    setCatalog: (catalog_dir: string, rebuild = false) =>
      request<{ ok: boolean }>('POST', '/admin/catalog', { body: { catalog_dir, confirm: true, rebuild } }),
    refresh: (prune: boolean, skipTags = false) =>
      request<{ ok: boolean; already_running?: boolean }>('POST', '/admin/refresh', {
        body: { prune, skip_tags: skipTags },
      }),
    retag: () => request<{ ok: boolean; already_running?: boolean }>('POST', '/admin/retag', { body: { confirm: true } }),
    progress: (signal?: AbortSignal) => request<IndexingState>('GET', '/admin/progress', { signal }),
    purge: () => request<{ ok: boolean }>('POST', '/admin/purge', { body: { confirm: true } }),
  },
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error)?.name === 'AbortError'
}
