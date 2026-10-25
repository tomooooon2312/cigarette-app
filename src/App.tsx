import { PenTracker } from './components/PenTracker'
import './App.css'
// 和紙の配色・書体・画面の配置。各画面の CSS の後に読み込んで上書きする
import './theme.css'

function App() {
  return (
    <main className="app">
      <PenTracker />
    </main>
  )
}

export default App
