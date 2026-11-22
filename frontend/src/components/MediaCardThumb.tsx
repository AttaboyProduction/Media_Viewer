import { useState } from 'react'
import type { MediaItem } from '../types'
import { mediaPreviewUrl, type PreviewSize } from '../utils/mediaPreview'

/** Square card picture. The original file loads only while a video is actually playing. */
export default function MediaCardThumb({
  item,
  size,
  playVideo = false,
  alt = '',
}: {
  item: MediaItem
  size: PreviewSize
  playVideo?: boolean
  alt?: string
}) {
  const [failed, setFailed] = useState(false)
  const preview = mediaPreviewUrl(item.id, size, item.file_size)

  if (item.media_type === 'video' && (playVideo || failed)) {
    return (
      <video
        src={item.media_url}
        poster={failed ? undefined : preview}
        muted
        loop
        playsInline
        autoPlay={playVideo && !failed}
        preload={playVideo ? 'metadata' : 'none'}
      />
    )
  }

  return (
    <img
      src={failed ? item.media_url : preview}
      alt={alt}
      loading="eager"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
