/**
 * 画面の切り替え（下部のタブ）。中央の「撮る」を朱色の丸で目立たせる。
 * 数値の調整は「設定」に分け、「撮る」の画面には出さない。
 */
export type Screen = 'guide' | 'camera' | 'settings'

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function BookIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5Z" />
      <path d="M12 6v13.5" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" />
      <circle cx="12" cy="13" r="3.6" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </svg>
  )
}

const ITEMS: { screen: Screen; label: string; icon: () => React.JSX.Element }[] = [
  { screen: 'guide', label: '遊び方', icon: BookIcon },
  { screen: 'camera', label: '撮る', icon: CameraIcon },
  { screen: 'settings', label: '設定', icon: GearIcon },
]

export function TabBar({ current, onSelect }: { current: Screen; onSelect: (s: Screen) => void }) {
  return (
    <nav className="tabbar" aria-label="メニュー">
      {ITEMS.map(({ screen, label, icon: Icon }) => (
        <button
          key={screen}
          type="button"
          className={`${screen === 'camera' ? 'tab-main' : ''} ${current === screen ? 'on' : ''}`}
          aria-current={current === screen ? 'page' : undefined}
          onClick={() => onSelect(screen)}
        >
          <span className="tab-icon">
            <Icon />
          </span>
          <span className="tab-label">{label}</span>
        </button>
      ))}
    </nav>
  )
}
