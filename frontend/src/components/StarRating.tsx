import { useState, type MouseEvent } from 'react'

interface Props {
  value: number | null
  onChange: (score: number) => void
  avg?: number | null
  count?: number
}

/** Partial fill 0–100 for one star (halves and arbitrary decimals like 4.56). */
export function fillForStar(score: number | null | undefined, star: number): number {
  if (score == null || score <= 0) return 0
  if (score >= star) return 100
  if (score <= star - 1) return 0
  return Math.round((score - (star - 1)) * 100)
}

function StarGlyph({ fill }: { fill: number }) {
  return (
    <>
      <span className="star-bg" aria-hidden>
        ★
      </span>
      <span className="star-fill" style={{ width: `${fill}%` }} aria-hidden>
        <span className="star-fill-glyph">★</span>
      </span>
    </>
  )
}

export function StarsDisplay({
  score,
  className = '',
  size = 'md',
}: {
  score: number | null | undefined
  className?: string
  size?: 'sm' | 'md'
}) {
  if (score == null || score <= 0) {
    return <span className={className}>Unrated</span>
  }
  return (
    <span
      className={`star-rating star-rating-readonly ${size === 'sm' ? 'star-rating-sm' : ''} ${className}`.trim()}
      aria-label={`${score} of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className="star star-readonly">
          <StarGlyph fill={fillForStar(score, star)} />
        </span>
      ))}
    </span>
  )
}

export default function StarRating({ value, onChange, avg, count }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const display = hover ?? value

  const pickFromEvent = (star: number, event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1)
    const half = ratio < 0.5 ? star - 0.5 : star
    return Math.min(5, Math.max(0.5, half))
  }

  return (
    <div>
      <div
        className="star-rating"
        onMouseLeave={() => setHover(null)}
        role="group"
        aria-label="Rating"
      >
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className="star"
            onMouseMove={(event) => setHover(pickFromEvent(star, event))}
            onClick={(event) => onChange(pickFromEvent(star, event))}
            aria-label={`Rate ${star - 0.5} or ${star} stars`}
          >
            <StarGlyph fill={fillForStar(display, star)} />
          </button>
        ))}
      </div>
      {value != null && value > 0 && (
        <div className="star-rating-value">
          {value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} / 5
        </div>
      )}
      {count !== undefined && count > 0 && (
        <div className="star-rating-avg">
          Avg {avg?.toFixed(2)} ({count} rating{count === 1 ? '' : 's'})
          {avg != null && <StarsDisplay score={avg} size="sm" />}
        </div>
      )}
    </div>
  )
}
