/** 遊び方（ジェスチャーと操作の説明）。カメラの映像の上に重ねて表示する */
const STEPS: { title: string; body: string }[] = [
  { title: 'ペンを持つ', body: '色のついたペン（初期はピンク）を映すと、タバコに変わります。口元に近い端が吸い口になります。' },
  { title: '火をつける', body: 'ペンを持っていない手で、親指と人差し指を軽くくっつけて素早く離します。「SNAP!」と指先に炎が出たら、タバコの先を炎に近づけます。' },
  { title: '吸う・吐く', body: '火のついたタバコの吸い口を口元へ。1 秒ほどくわえてから離し、口をすぼめると煙を吐きます。' },
  { title: '灰を落とす', body: '人差し指で、タバコを二回トントンと叩きます。' },
  { title: '火を消す', body: '指先の炎は、その手を振ると消えます。' },
  { title: 'シケモク', body: '火をつけて 60 秒たつとシケモクになります。画面の外に出して戻すと、新しい一本に。' },
  { title: '撮る・ポスター', body: '下の丸いボタンで撮影。「ポスターにする」で、六つの作風の映画ポスターに仕上げられます。' },
]

export function GuideScreen({ onClose }: { onClose: () => void }) {
  return (
    <section className="guide-screen" aria-label="遊び方">
      <header className="page-head">
        <h1>遊び方</h1>
        <p>ペン一本で、渋い一服を。</p>
      </header>
      <ol className="guide-list">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="guide-no" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '七'][i]}
            </span>
            <div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="guide-note">うまく反応しないときは「設定」で、判定の数値や色を調整できます。</p>
      <button type="button" className="btn-primary big" onClick={onClose}>
        撮りに行く
      </button>
    </section>
  )
}
