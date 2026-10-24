import { useEffect, useState } from 'react'
import { loadOpenCv, type OpenCv } from '../lib/opencv'

type OpenCvState =
  | { status: 'loading'; cv: null; error: null }
  | { status: 'ready'; cv: OpenCv; error: null }
  | { status: 'error'; cv: null; error: string }

export function useOpenCv(): OpenCvState {
  const [state, setState] = useState<OpenCvState>({
    status: 'loading',
    cv: null,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    loadOpenCv().then(
      (cv) => {
        if (!cancelled) setState({ status: 'ready', cv, error: null })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            cv: null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
