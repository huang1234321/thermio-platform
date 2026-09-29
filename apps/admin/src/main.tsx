/**
 * admin 入口（ADR-010：React + AntD（Vite））。
 * 会话恢复：有 refresh token 先换发再拉 /me；onAuthExpired 统一重登（§4.4）。
 * 主题：tokens.css 双套 + ThemeProvider（含 AntD ConfigProvider，登录页同享）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/app.js';
import { AuthProvider } from './app/auth-context.js';
import { ThemeProvider } from './app/theme.js';
import { tokenStore } from './app/api-client.js';
import './styles/tokens.css';

tokenStore.onAuthExpired = () => {
  globalThis.location.assign('/login');
};

const root = document.getElementById('root');
if (root === null) throw new Error('#root 不存在');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
