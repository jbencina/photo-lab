import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ToastProvider } from './components/Toast'
import { ThemeProvider } from './lib/theme'
import Library from './pages/Library'

const Admin = lazy(() => import('./pages/Admin'))

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<Library />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  )
}
