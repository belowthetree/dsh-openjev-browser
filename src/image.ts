/**
 * Capability-checked screenshot admission, mirroring dsh-mcp-client's
 * resolveImageAdmission + prepareImageProjection:
 *
 *   1. no `attachments` service -> text fallback
 *   2. resolve the active model route from the execution agent
 *   3. ask `llm.resolveModelInfo` whether the route accepts image input
 *   4. save the bytes via `attachments.saveImages`, yielding a ref the
 *      renderer turns into an image content block
 *
 * Every failure mode degrades to a text note; the screenshot itself is never
 * lost when the caller passed `path`.
 */

export interface AttachmentRef {
  [key: string]: unknown
}

export interface ImageAdmission {
  ok: boolean
  attachment?: AttachmentRef
  reason?: string
}

type Ctx = { get: (name: string) => any }
type Exec = { signal?: AbortSignal; agent?: any }

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function admitImage(
  ctx: Ctx,
  exec: Exec,
  data: Buffer,
  mediaType: string,
): Promise<ImageAdmission> {
  try {
    const attachments = ctx.get('attachments')
    if (!attachments) return { ok: false, reason: 'attachments service unavailable' }
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) return { ok: false, reason: `unsupported media type ${mediaType}` }

    const llm = ctx.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const route =
        exec?.agent?.session?.requestHeader?.()?.config ?? exec?.agent?.options ?? null
      const provider = route?.provider
      const model = route?.model
      if (!provider || !model) return { ok: false, reason: 'no active model route' }
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      const modalities: string[] = info?.inputModalities ?? info?.input_modalities ?? []
      if (!modalities.includes('image')) {
        return { ok: false, reason: `model ${provider}/${model} does not accept image input` }
      }
    }

    const refs = await attachments.saveImages([{ data, mediaType }])
    const ref = Array.isArray(refs) ? refs[0] : refs
    if (!ref) return { ok: false, reason: 'attachments.saveImages returned no reference' }
    return { ok: true, attachment: ref }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}
